import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { User, UserDocument } from './schemas/user.schema';
import { Tenant, TenantDocument } from './schemas/tenant.schema';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { isIpAllowed } from '../super-admin/tenant-security.guard';
import {
  generateAccountId,
  generateUserCode,
  hashSecret,
  normalizeIndianPhone,
  normalizeUserFeatureAccess,
  sanitizeOrganizationLogoUrl,
  sha256Hex,
  verifySecret,
} from './identity.util';
import { uploadToCloudinary } from './cloudinary.util';

export interface RegisterInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  companyName?: string;
  logoUrl?: string;
  city?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  private hashSecret(plain: string): string {
    return hashSecret(plain);
  }

  private verifySecret(plain: string, storedHash: string): boolean {
    return verifySecret(plain, storedHash);
  }

  /** Back-fills the 5-digit account ID / 10-digit user ID for accounts created before Module 10. */
  private async ensureIdentityCodes(user: UserDocument, tenant: TenantDocument | null) {
    if (tenant && !tenant.accountId) {
      tenant.accountId = await generateAccountId(this.tenantModel);
      await tenant.save();
    }
    if (!user.userCode) {
      user.userCode = await generateUserCode(this.userModel);
      await user.save();
    }
  }

  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const suffix = randomBytes(3).toString('hex');
    return `${base || 'workspace'}-${suffix}`;
  }

  private buildQuotaPayload(tenant: TenantDocument | null) {
    if (!tenant) return undefined;
    const q = tenant.quotas || {
      maxMonthlyAiCalls: 2500,
      maxMonthlyWhatsapp: 5000,
      aiCallsUsed: 0,
      whatsappUsed: 0,
      maxStorageMb: 2048,
    };
    const aiLimit = Math.max(1, q.maxMonthlyAiCalls || 2500);
    const waLimit = Math.max(1, q.maxMonthlyWhatsapp || 5000);
    const aiUsed = q.aiCallsUsed || 0;
    const waUsed = q.whatsappUsed || 0;
    const aiPct = Math.round((aiUsed / aiLimit) * 100);
    const waPct = Math.round((waUsed / waLimit) * 100);
    return {
      quotas: {
        maxMonthlyAiCalls: q.maxMonthlyAiCalls || 2500,
        maxMonthlyWhatsapp: q.maxMonthlyWhatsapp || 5000,
        aiCallsUsed: aiUsed,
        whatsappUsed: waUsed,
        maxStorageMb: q.maxStorageMb || 2048,
        aiPct,
        waPct,
        aiWarning: aiPct >= 80 && aiPct < 100,
        waWarning: waPct >= 80 && waPct < 100,
        aiExceeded: aiPct >= 100,
        waExceeded: waPct >= 100,
      },
    };
  }

  private async issueTokens(user: UserDocument, tenant: TenantDocument) {
    await this.ensureIdentityCodes(user, tenant);

    const payload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tenantId: tenant._id.toString(),
      sv: user.sessionVersion ?? 1,
      tsv: tenant.sessionVersion ?? 1,
    };

    const accessSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      'leadsetu_super_secret_refresh_key_2026_delhi_ncr';

    const ttlHours = Math.max(
      1,
      Math.min(720, tenant.securityPolicy?.sessionTtlHours || 24),
    );
    const accessExpiresIn =
      user.role === 'super_admin'
        ? this.configService.get<string>('JWT_EXPIRES_IN') || '1d'
        : `${ttlHours}h`;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: accessSecret,
        expiresIn: accessExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        secret: refreshSecret,
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
      }),
    ]);

    user.refreshTokenHash = this.hashSecret(refreshToken);
    user.lastLoginAt = new Date();
    await user.save();

    const effectiveState = this.superAdminService
      ? await this.superAdminService
          .getTenantEffectiveState(tenant._id.toString())
          .catch(() => null)
      : null;

    const viewerMasked = Boolean(
      user.maskPhones ||
        ((tenant.maskPhoneForAgents || effectiveState?.forcePhoneMasking) &&
          user.role === 'agent'),
    );

    const rawUser = user.toObject() as unknown as { createdAt?: Date };
    const normalizedFeatures = normalizeUserFeatureAccess(
      user.featureAccess,
      user.role,
      effectiveState?.effectiveFeatures,
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user._id.toString(),
        userCode: user.userCode || '',
        tenantId: tenant._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        role: user.role,
        departmentPreset: user.departmentPreset || 'sales',
        permissions: user.permissions || [],
        featureAccess: normalizedFeatures,
        territory: user.territory || '',
        monthlyTarget: user.monthlyTarget || 0,
        inviteStatus: user.inviteStatus || 'active',
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
        createdAt: rawUser.createdAt ? new Date(rawUser.createdAt).toISOString() : null,
        maskPhones: viewerMasked,
      },
      tenant: {
        id: tenant._id.toString(),
        accountId: tenant.accountId || '',
        name: tenant.name,
        companyName: (tenant.companyName || '').trim(),
        logoUrl: tenant.logoUrl || '',
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        city: tenant.city || 'Delhi-NCR',
        gstin: tenant.gstin || '',
        state: tenant.state || 'Delhi (07)',
        phone: tenant.phone || '',
        email: tenant.email || '',
        address: tenant.address || '',
        maskPhoneForAgents: Boolean(
          tenant.maskPhoneForAgents || effectiveState?.forcePhoneMasking,
        ),
        blockAgentExport: effectiveState?.blockCsvExport ?? (tenant.blockAgentExport ?? true),
        effectiveFeatures: effectiveState?.effectiveFeatures,
        effectiveFeatureDetails: effectiveState?.effectiveFeatureDetails,
        globalKillSwitches: effectiveState?.globalKillSwitches,
        maintenanceMode: effectiveState?.maintenanceMode ?? false,
        sessionTtlHours: tenant.securityPolicy?.sessionTtlHours || 24,
        ...(this.buildQuotaPayload(tenant) || {}),
      },
    };
  }

  async register(input: RegisterInput) {
    const platformConfig = this.superAdminService
      ? await this.superAdminService.ensureGlobalConfig().catch(() => null)
      : null;

    if (platformConfig?.maintenanceMode) {
      throw new ServiceUnavailableException(
        platformConfig.maintenanceBanner ||
          'Leadsetu Cloud is undergoing maintenance. Please try again shortly.',
      );
    }

    if (platformConfig && platformConfig.allowNewSignups === false) {
      throw new ForbiddenException(
        'New workspace registrations are temporarily paused by Leadsetu HQ.',
      );
    }

    const email = input.email?.trim().toLowerCase();
    const name = input.name?.trim();
    const password = input.password;

    if (!name || !email || !password) {
      throw new BadRequestException('Name, email, and password are required.');
    }

    const minPwd = Math.max(
      6,
      platformConfig?.securityPolicies?.minPasswordLength || 6,
    );
    if (password.length < 6) {
      throw new BadRequestException(
        `Password must be at least ${Math.min(6, minPwd)} characters long.`,
      );
    }

    const existingUser = await this.userModel.findOne({ email }).exec();
    if (existingUser) {
      throw new ConflictException('An account with this email already exists. Please sign in.');
    }

    const trialDays = platformConfig?.defaultTrialDays || 14;
    const trialEndsAt = new Date(Date.now() + trialDays * 86400000).toISOString();

    const cleanCompanyName = input.companyName?.trim() || '';
    const sanitizedLogo = sanitizeOrganizationLogoUrl(input.logoUrl);
    const cleanLogoUrl = sanitizedLogo
      ? await uploadToCloudinary(sanitizedLogo, {
          folder: 'leadsetu/org-logos',
          resourceType: 'image',
        })
      : '';
    const workspaceTitle = cleanCompanyName || 'Leadsetu Workspace';
    const tenant = await this.tenantModel.create({
      name: workspaceTitle,
      companyName: cleanCompanyName,
      logoUrl: cleanLogoUrl,
      slug: this.generateSlug(cleanCompanyName || 'workspace'),
      accountId: await generateAccountId(this.tenantModel),
      plan: 'growth',
      status: 'trial',
      trialEndsAt,
      city: input.city?.trim() || 'Delhi-NCR',
    });

    const user = await this.userModel.create({
      tenantId: tenant._id,
      userCode: await generateUserCode(this.userModel),
      name,
      email,
      phone: input.phone?.trim(),
      passwordHash: this.hashSecret(password),
      role: 'owner',
      departmentPreset: 'executive',
      permissions: ['*'],
      isActive: true,
    });

    return this.issueTokens(user, tenant);
  }

  async login(input: LoginInput, clientIp = '') {
    const email = input.email?.trim().toLowerCase();
    const password = input.password;

    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }

    const user = await this.userModel.findOne({ email }).exec();
    if (!user || !this.verifySecret(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Your account has been deactivated.');
    }

    const platformConfig = this.superAdminService
      ? await this.superAdminService.ensureGlobalConfig().catch(() => null)
      : null;

    if (platformConfig?.maintenanceMode && user.role !== 'super_admin') {
      throw new ServiceUnavailableException(
        platformConfig.maintenanceBanner ||
          'Leadsetu Cloud is currently in maintenance mode.',
      );
    }

    let tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) {
      tenant = await this.tenantModel.create({
        name: 'Leadsetu Workspace',
        companyName: '',
        slug: this.generateSlug('workspace'),
        plan: 'growth',
        status: 'trial',
      });
      user.tenantId = tenant._id as Types.ObjectId;
      await user.save();
    }

    if (user.role !== 'super_admin') {
      if (tenant.dpdpRetention?.purgedAt || tenant.dpdpRetention?.softDeletedAt) {
        throw new ForbiddenException(
          'This workspace is deactivated under DPDP erasure/retention policy.',
        );
      }
      if (tenant.status === 'suspended') {
        const reason = tenant.securityPolicy?.suspensionReason
          ? ` Reason: ${tenant.securityPolicy.suspensionReason}`
          : '';
        throw new ForbiddenException(
          `This workspace has been suspended by Leadsetu HQ.${reason} Please contact billing@leadsetu.in.`,
        );
      }
      if (clientIp && !isIpAllowed(clientIp, tenant.securityPolicy?.ipAllowlist)) {
        throw new ForbiddenException(
          `Login blocked: Your IP (${clientIp}) is not on this workspace's IP Allowlist.`,
        );
      }
    }

    return this.issueTokens(user, tenant);
  }

  async getProfileFromToken(authHeader?: string, clientIp = '') {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization token.');
    }

    const token = authHeader.slice(7).trim();
    const accessSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    let payload: {
      sub: string;
      tenantId: string;
      sv?: number;
      tsv?: number;
      isImpersonation?: boolean;
      impersonatorEmail?: string;
    };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        sv?: number;
        tsv?: number;
        isImpersonation?: boolean;
        impersonatorEmail?: string;
      }>(token, { secret: accessSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session. Please sign in again.');
    }

    const user = await this.userModel.findById(payload.sub).exec();
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer exists or is inactive.');
    }

    if (
      user.role !== 'super_admin' &&
      !payload.isImpersonation &&
      (payload.sv ?? 1) < (user.sessionVersion ?? 1)
    ) {
      throw new UnauthorizedException('Your session was revoked by security authority.');
    }

    const tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (user.role !== 'super_admin' && !payload.isImpersonation && tenant) {
      if (tenant.dpdpRetention?.purgedAt || tenant.dpdpRetention?.softDeletedAt) {
        throw new ForbiddenException('This workspace is queued for DPDP erasure.');
      }
      if (tenant.status === 'suspended') {
        throw new ForbiddenException('This workspace has been suspended by Leadsetu HQ.');
      }
      if ((payload.tsv ?? 1) < (tenant.sessionVersion ?? 1)) {
        throw new UnauthorizedException('All workspace sessions were revoked by security admin.');
      }
      if (clientIp && !isIpAllowed(clientIp, tenant.securityPolicy?.ipAllowlist)) {
        throw new ForbiddenException(
          `Access denied: Your IP (${clientIp}) is not on the workspace IP allowlist.`,
        );
      }
    }

    await this.ensureIdentityCodes(user, tenant);

    const effectiveState =
      tenant && this.superAdminService
        ? await this.superAdminService
            .getTenantEffectiveState(tenant._id.toString())
            .catch(() => null)
        : null;

    const viewerMasked = Boolean(
      user.maskPhones ||
        ((tenant?.maskPhoneForAgents || effectiveState?.forcePhoneMasking) &&
          user.role === 'agent'),
    );

    const rawUser = user.toObject() as unknown as { createdAt?: Date };
    const normalizedFeatures = normalizeUserFeatureAccess(
      user.featureAccess,
      user.role,
      effectiveState?.effectiveFeatures,
    );

    return {
      user: {
        id: user._id.toString(),
        userCode: user.userCode || '',
        tenantId: user.tenantId.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        role: user.role,
        departmentPreset: user.departmentPreset || 'sales',
        permissions: user.permissions || [],
        featureAccess: normalizedFeatures,
        territory: user.territory || '',
        monthlyTarget: user.monthlyTarget || 0,
        inviteStatus: user.inviteStatus || 'active',
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
        createdAt: rawUser.createdAt ? new Date(rawUser.createdAt).toISOString() : null,
        maskPhones: viewerMasked,
        isImpersonation: Boolean(payload.isImpersonation),
        impersonatorEmail: payload.impersonatorEmail || '',
      },
      tenant: tenant
        ? {
            id: tenant._id.toString(),
            accountId: tenant.accountId || '',
            name: tenant.name,
            companyName: (tenant.companyName || '').trim(),
            logoUrl: tenant.logoUrl || '',
            slug: tenant.slug,
            plan: tenant.plan,
            status: tenant.status,
            city: tenant.city || 'Delhi-NCR',
            gstin: tenant.gstin || '',
            state: tenant.state || 'Delhi (07)',
            phone: tenant.phone || '',
            email: tenant.email || '',
            address: tenant.address || '',
            maskPhoneForAgents: Boolean(
              tenant.maskPhoneForAgents || effectiveState?.forcePhoneMasking,
            ),
            blockAgentExport: effectiveState?.blockCsvExport ?? (tenant.blockAgentExport ?? true),
            effectiveFeatures: effectiveState?.effectiveFeatures,
            effectiveFeatureDetails: effectiveState?.effectiveFeatureDetails,
            globalKillSwitches: effectiveState?.globalKillSwitches,
            maintenanceMode: effectiveState?.maintenanceMode ?? false,
            sessionTtlHours: tenant.securityPolicy?.sessionTtlHours || 24,
            ...(this.buildQuotaPayload(tenant) || {}),
          }
        : null,
    };
  }

  async refresh(refreshToken?: string, clientIp = '') {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required.');
    }

    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      'leadsetu_super_secret_refresh_key_2026_delhi_ncr';

    let payload: { sub: string; tenantId: string; sv?: number; tsv?: number };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        sv?: number;
        tsv?: number;
      }>(refreshToken, { secret: refreshSecret });
    } catch {
      throw new UnauthorizedException('Refresh token expired or invalid.');
    }

    const user = await this.userModel.findById(payload.sub).exec();
    if (
      !user ||
      !user.isActive ||
      !user.refreshTokenHash ||
      !this.verifySecret(refreshToken, user.refreshTokenHash)
    ) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    const tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) {
      throw new UnauthorizedException('Workspace not found.');
    }
    if (user.role !== 'super_admin') {
      if (tenant.dpdpRetention?.purgedAt || tenant.dpdpRetention?.softDeletedAt) {
        throw new ForbiddenException('This workspace is queued for DPDP erasure.');
      }
      if (tenant.status === 'suspended') {
        throw new ForbiddenException('This workspace has been suspended by Leadsetu HQ.');
      }
      if (clientIp && !isIpAllowed(clientIp, tenant.securityPolicy?.ipAllowlist)) {
        throw new ForbiddenException(
          `Refresh blocked: Your IP (${clientIp}) is outside the workspace IP allowlist.`,
        );
      }
    }

    return this.issueTokens(user, tenant);
  }

  async logout(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { success: true };
    }
    try {
      const token = authHeader.slice(7).trim();
      const accessSecret =
        this.configService.get<string>('JWT_SECRET') ||
        'leadsetu_super_secret_access_key_2026_delhi_ncr';
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token, {
        secret: accessSecret,
      });
      await this.userModel
        .findByIdAndUpdate(payload.sub, { $set: { refreshTokenHash: null } })
        .exec();
    } catch {
      // Ignore expired token on logout
    }
    return { success: true };
  }

  async getInviteInfo(token?: string) {
    const cleanToken = token?.trim();
    if (!cleanToken) {
      throw new BadRequestException('Invite token is required.');
    }

    const tokenHash = sha256Hex(cleanToken);
    const user = await this.userModel.findOne({ inviteTokenHash: tokenHash }).exec();
    if (!user) {
      throw new BadRequestException(
        'This invite link is invalid or has already been used.',
      );
    }
    if (!user.isActive) {
      throw new ForbiddenException('Your user account is currently deactivated.');
    }
    if (user.inviteExpiresAt && new Date(user.inviteExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException(
        'This invite link has expired. Ask your workspace admin to resend the invite.',
      );
    }

    const tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) {
      throw new BadRequestException('Workspace not found for this invite.');
    }
    const [effectiveState, inviterUser] = await Promise.all([
      this.superAdminService
        ? this.superAdminService
            .getTenantEffectiveState(tenant._id.toString())
            .catch(() => null)
        : Promise.resolve(null),
      user.invitedBy
        ? this.userModel
            .findById(user.invitedBy)
            .select({ name: 1 })
            .exec()
        : this.userModel
            .findOne({ tenantId: tenant._id, role: 'owner' })
            .select({ name: 1 })
            .exec(),
    ]);

    const companyName = (tenant.companyName || '').trim();
    const invitedByDisplay =
      companyName || inviterUser?.name || 'Workspace Admin';

    return {
      valid: true,
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      userCode: user.userCode || '',
      role: user.role,
      territory: user.territory || '',
      inviteStatus: user.inviteStatus || 'pending',
      workspaceName: companyName || 'Leadsetu CRM',
      companyName,
      logoUrl: tenant.logoUrl || '',
      invitedByDisplay,
      accountId: tenant.accountId || '',
      featureAccess: normalizeUserFeatureAccess(
        user.featureAccess,
        user.role,
        effectiveState?.effectiveFeatures,
      ),
    };
  }

  async acceptInvite(
    input: {
      token: string;
      email: string;
      password?: string;
      newPassword?: string;
      mode?: 'login' | 'set_password';
    },
    clientIp = '',
  ) {
    const cleanToken = input.token?.trim();
    const email = input.email?.trim().toLowerCase();
    if (!cleanToken || !email) {
      throw new BadRequestException('Invite token and email address are required.');
    }

    const tokenHash = sha256Hex(cleanToken);
    const user = await this.userModel.findOne({ inviteTokenHash: tokenHash }).exec();
    if (!user) {
      throw new BadRequestException(
        'This invite link is invalid or has already been used.',
      );
    }
    if (user.email.toLowerCase() !== email) {
      throw new UnauthorizedException(
        'The entered email does not match the invited email address.',
      );
    }
    if (!user.isActive) {
      throw new ForbiddenException('Your user account has been deactivated.');
    }
    if (user.inviteExpiresAt && new Date(user.inviteExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException(
        'This invite link has expired. Please request a fresh invite from your admin.',
      );
    }

    const tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) {
      throw new BadRequestException('Workspace not found.');
    }
    if (tenant.status === 'suspended') {
      throw new ForbiddenException('This workspace is currently suspended.');
    }
    if (clientIp && !isIpAllowed(clientIp, tenant.securityPolicy?.ipAllowlist)) {
      throw new ForbiddenException(
        `Login blocked: Your IP (${clientIp}) is outside the workspace IP allowlist.`,
      );
    }

    const useSetPassword =
      input.mode === 'set_password' ||
      (Boolean(input.newPassword) && !input.password);

    if (useSetPassword) {
      const nextPwd = input.newPassword || input.password || '';
      if (nextPwd.length < 8) {
        throw new BadRequestException('Password must be at least 8 characters long.');
      }
      user.passwordHash = this.hashSecret(nextPwd);
    } else {
      const pwd = input.password || '';
      if (!pwd || !this.verifySecret(pwd, user.passwordHash)) {
        throw new UnauthorizedException('Incorrect password for this invited email.');
      }
      if (input.newPassword && input.newPassword.length >= 8) {
        user.passwordHash = this.hashSecret(input.newPassword);
      }
    }

    user.inviteStatus = 'accepted';
    user.inviteTokenHash = null;
    user.inviteExpiresAt = null;
    await user.save();

    return this.issueTokens(user, tenant);
  }

  async updateSelfProfile(
    authHeader: string | undefined,
    input: { name?: string; phone?: string; territory?: string },
  ) {
    const profile = await this.getProfileFromToken(authHeader);
    const user = await this.userModel.findById(profile.user.id).exec();
    if (!user) throw new UnauthorizedException('User not found.');

    if (input.name !== undefined) {
      const cleanName = input.name.trim();
      if (!cleanName) throw new BadRequestException('Name cannot be empty.');
      user.name = cleanName;
    }
    if (input.phone !== undefined && input.phone.trim() !== '') {
      const normalized = normalizeIndianPhone(input.phone);
      if (!normalized) {
        throw new BadRequestException(
          'Enter a valid 10-digit Indian mobile number.',
        );
      }
      user.phone = normalized;
    }
    if (input.territory !== undefined) {
      user.territory = input.territory.trim();
    }
    await user.save();
    return this.getProfileFromToken(authHeader);
  }

  async changePassword(
    authHeader: string | undefined,
    input: { currentPassword: string; newPassword: string },
  ) {
    const profile = await this.getProfileFromToken(authHeader);
    const user = await this.userModel.findById(profile.user.id).exec();
    if (!user) throw new UnauthorizedException('User not found.');

    if (!input.currentPassword || !this.verifySecret(input.currentPassword, user.passwordHash)) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    if (!input.newPassword || input.newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters.');
    }
    user.passwordHash = this.hashSecret(input.newPassword);
    await user.save();
    return { success: true };
  }
}
