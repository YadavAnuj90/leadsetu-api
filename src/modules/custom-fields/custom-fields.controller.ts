import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApplyCustomFieldPresetDto,
  CreateCustomFieldDto,
  ReorderCustomFieldsDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';
import { CustomFieldsService } from './custom-fields.service';

@ApiTags('14. Custom Fields Builder')
@ApiBearerAuth('access-token')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly customFieldsService: CustomFieldsService) {}

  @Get()
  @ApiOperation({
    summary: 'List custom fields defined for Leads, Contacts, and Deals',
    description:
      'Returns ordered tenant custom field schemas (`text`, `number`, `dropdown`, `date`, `checkbox`), optionally filtered by entity.',
  })
  @ApiQuery({
    name: 'entity',
    required: false,
    enum: ['lead', 'contact', 'deal'],
    description: 'Filter custom fields by CRM entity',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'Include archived/inactive fields (default false)',
  })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query('entity') entity?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.listFields(
      auth,
      entity,
      includeInactive === 'true',
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a custom field on Leads, Contacts, or Deals (Owner/Admin)',
    description:
      'Adds an industry-specific custom field (`MOQ`, `Credit Days`, `Drug License No.`, etc.) that renders dynamically across forms and detail views.',
  })
  @ApiBody({ type: CreateCustomFieldDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateCustomFieldDto,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.createField(auth, dto);
  }

  @Post('preset')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Import an Indian B2B industry custom-fields starter pack (Owner/Admin)',
    description:
      'Creates curated custom fields across Leads, Contacts, and Deals for Manufacturing, Pharma, Wholesale Distribution, or Real Estate.',
  })
  @ApiBody({ type: ApplyCustomFieldPresetDto })
  async applyPreset(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: ApplyCustomFieldPresetDto,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.applyPreset(auth, dto);
  }

  @Patch('reorder')
  @ApiOperation({
    summary: 'Reorder custom fields within an entity (Owner/Admin)',
    description: 'Updates display sort order for Lead, Contact, or Deal custom fields.',
  })
  @ApiBody({ type: ReorderCustomFieldsDto })
  async reorder(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: ReorderCustomFieldsDto,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.reorderFields(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update custom field metadata, options, or active state (Owner/Admin)',
    description: 'Edits label, type, dropdown choices, required flag, placeholder, or active state while keeping the underlying key stable.',
  })
  @ApiParam({ name: 'id', description: 'Custom field ID' })
  @ApiBody({ type: UpdateCustomFieldDto })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDto,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.updateField(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a custom field definition (Owner/Admin)',
    description: 'Removes the custom field schema definition from the workspace.',
  })
  @ApiParam({ name: 'id', description: 'Custom field ID' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.customFieldsService.verifyAuth(authorization);
    return this.customFieldsService.deleteField(auth, id);
  }
}
