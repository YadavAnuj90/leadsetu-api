import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { User, UserDocument } from './schemas/user.schema';
import { Tenant, TenantDocument } from './schemas/tenant.schema';
import {
  generateAccountId,
  generateUserCode,
  hashSecret,
  verifySecret,
} from './identity.util';

export interface RegisterInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  companyName?: string;
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

  private async issueTokens(user: UserDocument, tenant: TenantDocument) {
    await this.ensureIdentityCodes(user, tenant);

    const payload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tenantId: tenant._id.toString(),
    };

    const accessSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      'leadsetu_super_secret_refresh_key_2026_delhi_ncr';

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: accessSecret,
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') || '1d',
      }),
      this.jwtService.signAsync(payload, {
        secret: refreshSecret,
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
      }),
    ]);

    user.refreshTokenHash = this.hashSecret(refreshToken);
    user.lastLoginAt = new Date();
    await user.save();

    const viewerMasked = Boolean(
      user.maskPhones || (tenant.maskPhoneForAgents && user.role === 'agent'),
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
        maskPhones: viewerMasked,
      },
      tenant: {
        id: tenant._id.toString(),
        accountId: tenant.accountId || '',
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        city: tenant.city || 'Delhi-NCR',
        maskPhoneForAgents: Boolean(tenant.maskPhoneForAgents),
        blockAgentExport: tenant.blockAgentExport ?? true,
      },
    };
  }

  async register(input: RegisterInput) {
    const email = input.email?.trim().toLowerCase();
    const name = input.name?.trim();
    const password = input.password;

    if (!name || !email || !password) {
      throw new BadRequestException('Name, email, and password are required.');
    }

    if (password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters long.');
    }

    const existingUser = await this.userModel.findOne({ email }).exec();
    if (existingUser) {
      throw new ConflictException('An account with this email already exists. Please sign in.');
    }

    const companyName = input.companyName?.trim() || `${name}'s Workspace`;
    const tenant = await this.tenantModel.create({
      name: companyName,
      slug: this.generateSlug(companyName),
      accountId: await generateAccountId(this.tenantModel),
      plan: 'growth',
      status: 'trial',
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
      isActive: true,
    });

    return this.issueTokens(user, tenant);
  }

  async login(input: LoginInput) {
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

    let tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) {
      tenant = await this.tenantModel.create({
        name: `${user.name}'s Workspace`,
        slug: this.generateSlug(user.name),
        plan: 'growth',
        status: 'trial',
      });
      user.tenantId = tenant._id as Types.ObjectId;
      await user.save();
    }

    return this.issueTokens(user, tenant);
  }

  async getProfileFromToken(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization token.');
    }

    const token = authHeader.slice(7).trim();
    const accessSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
      }>(token, { secret: accessSecret });

      const user = await this.userModel.findById(payload.sub).exec();
      if (!user) {
        throw new UnauthorizedException('User no longer exists.');
      }

      const tenant = await this.tenantModel.findById(user.tenantId).exec();
      await this.ensureIdentityCodes(user, tenant);

      const viewerMasked = Boolean(
        user.maskPhones || (tenant?.maskPhoneForAgents && user.role === 'agent'),
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
          maskPhones: viewerMasked,
        },
        tenant: tenant
          ? {
              id: tenant._id.toString(),
              accountId: tenant.accountId || '',
              name: tenant.name,
              slug: tenant.slug,
              plan: tenant.plan,
              status: tenant.status,
              city: tenant.city || 'Delhi-NCR',
              maskPhoneForAgents: Boolean(tenant.maskPhoneForAgents),
              blockAgentExport: tenant.blockAgentExport ?? true,
            }
          : null,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session. Please sign in again.');
    }
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required.');
    }

    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      'leadsetu_super_secret_refresh_key_2026_delhi_ncr';

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
      }>(refreshToken, { secret: refreshSecret });

      const user = await this.userModel.findById(payload.sub).exec();
      if (
        !user ||
        !user.refreshTokenHash ||
        !this.verifySecret(refreshToken, user.refreshTokenHash)
      ) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      const tenant = await this.tenantModel.findById(user.tenantId).exec();
      if (!tenant) {
        throw new UnauthorizedException('Workspace not found.');
      }

      return this.issueTokens(user, tenant);
    } catch {
      throw new UnauthorizedException('Refresh token expired or invalid.');
    }
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
}
