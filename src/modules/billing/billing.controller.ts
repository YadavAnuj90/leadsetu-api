import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  BillingService,
  CreateCheckoutOrderDto,
  SandboxAuthorizeCheckoutDto,
  ValidateCouponDto,
  VerifyCheckoutPaymentDto,
} from './billing.service';

@ApiTags('15. SaaS Billing, Razorpay Checkout & Webhooks')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('summary')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Get workspace subscription summary, seat & quota usage, Razorpay checkout config, and attached GST invoices',
  })
  async getSummary(@Headers('authorization') authorization?: string) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.getSummary(auth);
  }

  @Get('usage')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Get Metered Entitlements & Usage Dashboard (Seats, AI Calls, WhatsApp Broadcasts, Storage, Dunning Expiry/Grace & Top-Up Packs)',
  })
  async getUsage(@Headers('authorization') authorization?: string) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.getUsageDashboard(auth);
  }

  @Get('proration')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Preview prorated unused-day upgrade credit, optional coupon discount & 18% GST recalculation',
  })
  async getProrationPreview(
    @Headers('authorization') authorization: string | undefined,
    @Query('plan') plan: 'starter' | 'growth' | 'enterprise',
    @Query('billingCycle') billingCycle?: 'monthly' | 'annual',
    @Query('couponCode') couponCode?: string,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.getProrationPreview(
      auth,
      plan,
      billingCycle === 'annual' ? 'annual' : 'monthly',
      couponCode,
    );
  }

  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pause / cancel subscription auto-renewal at period end',
  })
  async cancelAtPeriodEnd(
    @Headers('authorization') authorization: string | undefined,
    @Body() body?: { reason?: string },
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.cancelSubscriptionAtPeriodEnd(auth, body || {});
  }

  @Post('subscription/resume')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Resume subscription auto-renewal and clear pending downgrade',
  })
  async resumeAutoRenewal(
    @Headers('authorization') authorization?: string,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.resumeAutoRenewal(auth);
  }

  @Post('subscription/schedule-downgrade')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Schedule a lower-tier plan downgrade effective at current period end',
  })
  async scheduleDowngrade(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      targetPlan: 'starter' | 'growth';
      billingCycle?: 'monthly' | 'annual';
      reason?: string;
    },
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.schedulePlanDowngrade(auth, body);
  }

  @Get('refund-requests')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List workspace GST Credit Note / Refund requests',
  })
  async listRefundRequests(
    @Headers('authorization') authorization?: string,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.listRefundRequests(auth);
  }

  @Post('refund-requests')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Raise a GST Credit Note / Refund request linked directly to Super Admin refund workflow',
  })
  async createRefundRequest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { invoiceId: string; reason: string },
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.createRefundRequest(auth, body);
  }

  @Post('coupons/validate')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Validate a Super Admin Promo / Coupon code and compute discounted base price + 18% GST split',
  })
  async validateCoupon(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: ValidateCouponDto,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.validateCoupon(auth, dto);
  }

  @Post('checkout/order')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Create a Razorpay Subscription Checkout Order with optional coupon redemption and 18% GST calculation',
  })
  async createCheckoutOrder(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateCheckoutOrderDto,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.createCheckoutOrder(auth, dto);
  }

  @Post('checkout/sandbox-authorize')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Authorize a Leadsetu sandbox checkout order and issue a valid HMAC-SHA256 signed payment payload for verification',
  })
  async authorizeSandboxOrder(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SandboxAuthorizeCheckoutDto,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.authorizeSandboxOrder(auth, dto);
  }

  @Post('checkout/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Verify Razorpay payment HMAC-SHA256 signature, redeem coupon, activate subscription plan, and attach GST Tax Invoice',
  })
  async verifyCheckoutPayment(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: VerifyCheckoutPaymentDto,
  ) {
    const auth = await this.billingService.verifyAuth(authorization);
    return this.billingService.verifyCheckoutPayment(auth, dto);
  }

  @Post('webhooks/razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Public Razorpay Webhook endpoint (verifies X-Razorpay-Signature for payment.captured, order.paid, payment.failed, refund.created)',
  })
  async handleRazorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.billingService.handleRazorpayWebhook(
      req.rawBody,
      signature,
      payload || {},
    );
  }
}
