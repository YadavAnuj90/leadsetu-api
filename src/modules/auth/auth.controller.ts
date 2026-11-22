import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, LoginInput, RegisterInput } from './auth.service';
import type { WorkspaceBusinessMode } from './business-mode.util';
import { extractClientIp } from '../super-admin/tenant-security.guard';

export class RegisterSwaggerDto implements RegisterInput {
  @ApiProperty({
    description: 'Full name of the user / founder',
    example: 'Rajesh Sharma',
  })
  name!: string;

  @ApiProperty({
    description: 'Work email address (used for login)',
    example: 'rajesh@rselectricals.in',
  })
  email!: string;

  @ApiPropertyOptional({
    description: 'WhatsApp mobile number with country code',
    example: '+91 98112 45678',
  })
  phone?: string;

  @ApiProperty({
    description: 'Account password (minimum 6 characters)',
    example: 'Leadsetu@2026',
    minLength: 6,
  })
  password!: string;

  @ApiPropertyOptional({
    description: 'Optional Company or Organization Name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  companyName?: string;

  @ApiPropertyOptional({
    description: 'Optional Organization Logo image (PNG/JPG/WEBP data URL or HTTPS URL)',
  })
  logoUrl?: string;

  @ApiPropertyOptional({
    description: 'Primary business city / hub',
    example: 'Noida Electronic City',
    default: 'Delhi-NCR',
  })
  city?: string;

  @ApiPropertyOptional({
    enum: ['b2b', 'msme', 'b2c', 'hybrid', 'bpo', 'education'],
    default: 'b2b',
    description: 'Workspace segment preset shaping CRM labels and default modules',
  })
  businessMode?: WorkspaceBusinessMode;
}

export class LoginSwaggerDto implements LoginInput {
  @ApiProperty({
    description: 'Registered work email address',
    example: 'rajesh@rselectricals.in',
  })
  email!: string;

  @ApiProperty({
    description: 'Account password',
    example: 'Leadsetu@2026',
  })
  password!: string;
}

const REFRESH_COOKIE_NAME = 'leadsetu_refresh_token';
const SA_REFRESH_COOKIE_NAME = 'leadsetu_sa_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth/refresh';

function extractCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

@ApiTags('1. Auth & Workspace')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setRefreshCookieAndStrip(
    res: Response,
    result: {
      accessToken: string;
      refreshToken: string;
      user: unknown;
      tenant: unknown;
    },
  ) {
    const role = String(
      (result.user as { role?: string } | null | undefined)?.role || '',
    );
    const cookieName =
      role === 'super_admin' ? SA_REFRESH_COOKIE_NAME : REFRESH_COOKIE_NAME;

    // Clear any legacy root-scoped cookies so old path:'/' tokens are not sent on every API call
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    res.clearCookie(SA_REFRESH_COOKIE_NAME, { path: '/' });

    res.cookie(cookieName, result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Never expose refreshToken in the JSON response body
    return {
      accessToken: result.accessToken,
      user: result.user,
      tenant: result.tenant,
    };
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new Workspace Tenant & Owner User',
    description:
      'Creates a new Tenant workspace in Leadsetu Cloud, sets the 7-day refreshToken in an HttpOnly cookie, and returns `{ accessToken, user, tenant }`.',
  })
  @ApiBody({ type: RegisterSwaggerDto })
  @ApiResponse({
    status: 201,
    description: 'Workspace registered. Refresh token set in HttpOnly cookie.',
  })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  async register(
    @Body() body: RegisterSwaggerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(body);
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Alias for /v1/auth/register (Signup)',
    description:
      'Creates a new Tenant + Owner account, sets HttpOnly refresh cookie, and returns `{ accessToken, user, tenant }`.',
  })
  @ApiBody({ type: RegisterSwaggerDto })
  @ApiResponse({ status: 201, description: 'Account created successfully.' })
  async signup(
    @Body() body: RegisterSwaggerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(body);
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login with email and password',
    description:
      'Verifies credentials, stores `refreshToken` inside an `HttpOnly` cookie (`leadsetu_refresh_token`), and returns only `{ accessToken, user, tenant }` in the JSON body.',
  })
  @ApiBody({ type: LoginSwaggerDto })
  @ApiResponse({
    status: 200,
    description: 'Authenticated. Refresh token stored in HttpOnly cookie.',
  })
  @ApiResponse({ status: 401, description: 'Invalid email or password.' })
  async login(
    @Body() body: LoginSwaggerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body, extractClientIp(req));
    if (!('accessToken' in result)) {
      return result;
    }
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh expired accessToken using HttpOnly refresh cookie',
    description:
      'Reads `leadsetu_refresh_token` from the incoming HttpOnly cookie, rotates both tokens, sets the new HttpOnly cookie, and returns `{ accessToken, user, tenant }`.',
  })
  @ApiResponse({ status: 200, description: 'New accessToken issued.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh cookie.' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        refreshToken: { type: 'string', description: 'Optional refresh token fallback for API/mobile clients (browser uses HttpOnly cookie).' },
      },
    },
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyFallbackToken?: string,
  ) {
    const scopeHeader = String(req.headers['x-auth-scope'] || '').toLowerCase();
    const isSuperAdminScope = scopeHeader === 'super_admin';
    const cookieName = isSuperAdminScope
      ? SA_REFRESH_COOKIE_NAME
      : REFRESH_COOKIE_NAME;
    const cookieToken = extractCookie(req.headers.cookie, cookieName);
    const result = await this.authService.refresh(
      cookieToken || bodyFallbackToken,
      extractClientIp(req),
    );
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logout, invalidate refreshToken in DB, and clear HttpOnly cookie',
  })
  @ApiResponse({ status: 200, description: 'Logged out and cookie cleared.' })
  async logout(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const scopeHeader = String(req.headers['x-auth-scope'] || '').toLowerCase();
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    res.clearCookie(SA_REFRESH_COOKIE_NAME, { path: '/' });
    if (scopeHeader === 'super_admin') {
      res.clearCookie(SA_REFRESH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
      });
    } else if (scopeHeader === 'workspace') {
      res.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
      });
    } else {
      res.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
      });
      res.clearCookie(SA_REFRESH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
      });
    }
    return this.authService.logout(authorization);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current logged-in User & Tenant profile',
    description: 'Requires Bearer accessToken in the Authorization header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns authenticated user and workspace tenant details.',
  })
  @ApiResponse({ status: 401, description: 'Missing or expired token.' })
  async me(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
  ) {
    return this.authService.getProfileFromToken(authorization, extractClientIp(req));
  }

  @Get('invite-info')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspect a team invite link token before signing in or activating',
    description: 'Returns masked invitee email, role, and target workspace name for the invite token.',
  })
  @ApiQuery({ name: 'token', required: true, description: 'One-time workspace invite token from email/WhatsApp link' })
  async inviteInfo(@Query('token') token?: string) {
    return this.authService.getInviteInfo(token);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a workspace invite link with email & password (or set new password) and sign in',
    description: 'Activates an invited user or lets an existing user join using the invite token, setting the scoped HttpOnly refresh cookie.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['token', 'email'],
      properties: {
        token: { type: 'string', example: 'inv_tok_8f3b2c...' },
        email: { type: 'string', example: 'rohit.verma@rselectricals.in' },
        password: { type: 'string', example: 'Leadsetu@2026' },
        newPassword: { type: 'string', example: 'Leadsetu@2026' },
        mode: { type: 'string', enum: ['login', 'set_password'], example: 'set_password' },
      },
    },
  })
  async acceptInvite(
    @Body()
    body: {
      token: string;
      email: string;
      password?: string;
      newPassword?: string;
      mode?: 'login' | 'set_password';
    },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.acceptInvite(body, extractClientIp(req));
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update the signed-in user profile (name, phone, territory)',
    description: 'Updates own display name, mobile number, and sales territory.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'Anjali Yadav' },
        phone: { type: 'string', example: '+91 9811001122' },
        territory: { type: 'string', example: 'Noida Sector 62' },
      },
    },
  })
  async updateProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { name?: string; phone?: string; territory?: string },
  ) {
    return this.authService.updateSelfProfile(authorization, body);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change password for the signed-in user',
    description: 'Verifies current password before updating password hash.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      properties: {
        currentPassword: { type: 'string', example: 'OldPass@2026' },
        newPassword: { type: 'string', example: 'NewStrongPass@2026' },
      },
    },
  })
  async changePassword(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(authorization, body);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a one-time password reset link by email',
    description:
      'Sends a 30-minute expiring one-time password reset link if an active workspace user matches the provided email address.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: {
          type: 'string',
          format: 'email',
          example: 'rajesh@rselectricals.in',
          description: 'Registered workspace email address',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Generic confirmation returned (never enumerates accounts in production)' })
  async forgotPassword(
    @Body() body: { email: string },
    @Req() req: Request,
  ) {
    const originHeader = req.headers.origin;
    return this.authService.requestPasswordReset(body?.email, originHeader);
  }

  @Get('reset-password/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a password reset link token before showing reset form',
    description:
      'Validates token expiry/existence and returns masked email and workspace name without consuming the token.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description: 'One-time reset token from the password reset link',
  })
  async verifyResetToken(@Query('token') token?: string) {
    return this.authService.verifyResetPasswordToken(token);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete password reset using one-time token',
    description:
      'Validates the one-time token, updates the password hash, invalidates prior sessions, and consumes the token.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['token', 'newPassword'],
      properties: {
        token: {
          type: 'string',
          example: 'rst_8f3b2c...',
          description: 'One-time password reset token from email link',
        },
        newPassword: {
          type: 'string',
          minLength: 8,
          example: 'NewStrongPass@2026',
          description: 'New password (minimum 8 characters)',
        },
      },
    },
  })
  async resetPassword(
    @Body() body: { token: string; newPassword: string },
    @Req() req: Request,
  ) {
    return this.authService.resetPassword(body, extractClientIp(req));
  }

  @Get('google/config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check Google OAuth SSO configuration status',
    description: 'Returns `{ enabled, clientId }` so the frontend knows whether Google Identity Services can render Sign-In with Google.',
  })
  getGoogleConfig() {
    return this.authService.getGoogleAuthConfig();
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Continue with Google OAuth (ID Token sign-in or workspace signup)',
    description:
      'Verifies a Google Identity Services `idToken` against Google, links/creates the workspace user, enforces 2FA if enabled, and issues JWT + HttpOnly refresh cookie.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['idToken'],
      properties: {
        idToken: { type: 'string', description: 'Google Sign-In credential JWT returned by Google Identity Services' },
        companyName: { type: 'string', example: 'RS Electricals Pvt. Ltd.', description: 'Optional organization name for first-time signups' },
      },
    },
  })
  async googleLogin(
    @Body() body: { idToken: string; companyName?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.authenticateWithGoogle(
      body,
      extractClientIp(req),
    );
    if (!('accessToken' in result)) {
      return result;
    }
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Post('2fa/verify-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete login with 6-digit Authenticator App TOTP (or 8-char backup code)',
    description: 'Validates the short-lived `challengeToken` and 6-digit TOTP/backup code to issue accessToken and HttpOnly refresh cookie.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['challengeToken', 'code'],
      properties: {
        challengeToken: { type: 'string' },
        code: { type: 'string', example: '123456', description: '6-digit TOTP code or 8-char backup code' },
      },
    },
  })
  async verifyTwoFactorLogin(
    @Body() body: { challengeToken: string; code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyTwoFactorLogin(
      body,
      extractClientIp(req),
    );
    return this.setRefreshCookieAndStrip(res, result);
  }

  @Get('2fa/status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current user Authenticator App (TOTP) 2FA status',
    description: 'Returns `{ enabled, backupCodesRemaining }` for the signed-in user.',
  })
  async getTwoFactorStatus(
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.authService.getTwoFactorStatus(authorization);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Generate TOTP Authenticator QR code & Base32 secret',
    description: 'Creates a pending TOTP secret and returns an offline QR PNG DataURL plus manual setup secret.',
  })
  async setupTwoFactor(
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.authService.setupTwoFactor(authorization);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Verify 6-digit TOTP code & activate 2FA with backup codes',
    description: 'Verifies the code generated by Google/Microsoft Authenticator and returns 8 one-time recovery codes.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', example: '123456' },
      },
    },
  })
  async enableTwoFactor(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { code: string },
  ) {
    return this.authService.enableTwoFactor(authorization, body?.code);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Disable Authenticator App (TOTP) 2FA',
    description: 'Requires either a valid 6-digit TOTP code or the user password to turn off 2FA.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
        currentPassword: { type: 'string' },
      },
    },
  })
  async disableTwoFactor(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { code?: string; currentPassword?: string },
  ) {
    return this.authService.disableTwoFactor(authorization, body);
  }
}
