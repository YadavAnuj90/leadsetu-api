import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto {
  @ApiProperty({
    description: 'Actionable title of the follow-up task',
    example: 'Share revised 18% GST proforma quote for 500 units',
  })
  title!: string;

  @ApiPropertyOptional({
    description: 'Context or agenda for the follow-up',
    example:
      'Include 12% bulk discount + Razorpay advance payment link on WhatsApp.',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Urgency priority level',
    enum: ['high', 'medium', 'low'],
    default: 'high',
    example: 'high',
  })
  priority?: 'high' | 'medium' | 'low';

  @ApiPropertyOptional({
    description: 'Task completion status',
    enum: ['pending', 'in_progress', 'done'],
    default: 'pending',
    example: 'pending',
  })
  status?: 'pending' | 'in_progress' | 'done';

  @ApiPropertyOptional({
    description: 'Sales activity category',
    enum: ['call', 'whatsapp', 'meeting', 'quote', 'followup'],
    default: 'whatsapp',
    example: 'quote',
  })
  category?: 'call' | 'whatsapp' | 'meeting' | 'quote' | 'followup';

  @ApiPropertyOptional({
    description: 'Due date (YYYY-MM-DD)',
    example: '2026-11-10',
  })
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Related buyer / lead name',
    example: 'Rajesh Sharma',
  })
  relatedName?: string;

  @ApiPropertyOptional({
    description: 'Related buyer company name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  relatedCompany?: string;

  @ApiPropertyOptional({
    description: 'Related buyer WhatsApp / mobile phone (+91)',
    example: '+91 98112 45678',
  })
  relatedPhone?: string;
}

export class UpdateTaskDto extends CreateTaskDto {}
