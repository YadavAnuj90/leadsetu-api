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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateContactDto, UpdateContactDto } from './dto/contacts.dto';
import { ContactsService } from './contacts.service';

@ApiTags('4. Contacts & GST Directory')
@ApiBearerAuth('access-token')
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all B2B contacts, GSTIN records & cumulative LTV stats',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Search by contact name, company, 15-digit GSTIN, phone, or city',
    example: '07AABCR',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['all', 'customer', 'prospect', 'partner', 'vendor'],
    description: 'Filter by B2B account type',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Contact[], stats: ContactsStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; type?: string },
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.findAll(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get 360° profile for a single B2B contact by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique contact record ID',
    example: 'cnt_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Contact profile returned.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new B2B contact & GST account record',
  })
  @ApiBody({ type: CreateContactDto })
  @ApiResponse({ status: 201, description: 'Contact created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateContactDto,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update B2B contact details, GSTIN, or Lifetime Value',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique contact record ID',
    example: 'cnt_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateContactDto })
  @ApiResponse({ status: 200, description: 'Contact updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateContactDto,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.update(auth, id, dto);
  }

  @Post(':id/verify-gstin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify 15-digit Indian GSTIN format, state code & Mod-36 checksum',
    description: 'Validates GSTIN structure, extracts state code, and marks verification status on the contact.',
  })
  @ApiParam({ name: 'id', description: 'Unique contact record ID', example: 'cnt_01a2b3c4d5e6' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        gstin: { type: 'string', example: '09AABCR1234F1Z5', description: 'Optional GSTIN override to validate before saving' },
      },
    },
  })
  async verifyGstin(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { gstin?: string },
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.verifyGstin(auth, id, body?.gstin);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a contact from the directory',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique contact record ID',
    example: 'cnt_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Contact deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.remove(auth, id);
  }
}
