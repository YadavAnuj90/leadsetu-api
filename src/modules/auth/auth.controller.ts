import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, LoginInput, RegisterInput } from './auth.service';

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
    description: 'Company or Business Workspace Name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  companyName?: string;

  @ApiPropertyOptional({
    description: 'Primary business city / hub',
    example: 'Noida Electronic City',
    default: 'Delhi-NCR',
  })
  city?: string;
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
    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
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
      'Creates a new Tenant workspace in MongoDB Atlas, sets the 7-day refreshToken in an HttpOnly cookie, and returns `{ accessToken, user, tenant }`.',
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body);
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
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyFallbackToken?: string,
  ) {
    const cookieToken = extractCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
    const result = await this.authService.refresh(
      cookieToken || bodyFallbackToken,
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
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
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
  async me(@Headers('authorization') authorization?: string) {
    return this.authService.getProfileFromToken(authorization);
  }
}
