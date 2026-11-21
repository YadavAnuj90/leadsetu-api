import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTenantProfileDto {
  @ApiPropertyOptional({ example: 'Anujalite Technologies Pvt. Ltd.' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Optional Company / Organization display name (empty string clears it)',
    example: 'Anujalite Technologies Pvt. Ltd.',
  })
  companyName?: string;

  @ApiPropertyOptional({
    description: 'Optional Organization Logo image (data URL or HTTPS URL, empty string clears it)',
  })
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'New Delhi' })
  city?: string;

  @ApiPropertyOptional({ example: '07AABCA9012H1Z8' })
  gstin?: string;

  @ApiPropertyOptional({ example: 'Delhi (07)' })
  state?: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  phone?: string;

  @ApiPropertyOptional({ example: 'billing@anujalite.in' })
  email?: string;

  @ApiPropertyOptional({
    example: 'B-42, Okhla Industrial Area Phase-II, New Delhi - 110020',
  })
  address?: string;
}

export class SubscribePlanDto {
  @ApiProperty({ enum: ['starter', 'growth', 'enterprise'], example: 'growth' })
  plan!: 'starter' | 'growth' | 'enterprise';

  @ApiPropertyOptional({
    enum: ['monthly', 'annual'],
    default: 'monthly',
  })
  billingCycle?: 'monthly' | 'annual';

  @ApiPropertyOptional({ example: 'Razorpay UPI / NEFT' })
  paymentMode?: string;

  @ApiPropertyOptional({ example: 'RZP-SUB-992841' })
  paymentReference?: string;

  @ApiPropertyOptional({
    example:
      'Thank you for choosing Leadsetu to bridge every B2B lead, deal & GST workflow!',
  })
  greetingNote?: string;

  @ApiPropertyOptional({
    description: 'Optional Super Admin promo/coupon code applied before 18% GST',
    example: 'LAUNCH20',
  })
  couponCode?: string;
}

export interface TenantAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}
