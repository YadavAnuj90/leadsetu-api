// ─────────────────────────────────────────────────────
//  LEADSETU SHARED CONTRACTS  (types/contracts.ts)
//  ⚠️  Keep this file IN SYNC across all 3 repos:
//      leadsetu-ai   → src/types/contracts.ts
//      leadsetu-api  → src/types/contracts.ts
//      leadsetu-web  → src/types/contracts.ts
// ─────────────────────────────────────────────────────

// ── Pagination ───────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    cursor?: string;
  };
}

// ── Lead ─────────────────────────────────────────────

export interface Lead {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  phone?: string;
  email?: string;
  source?: string;
  status: LeadStatus;
  tags: string[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';

// ── Contact ──────────────────────────────────────────

export interface Contact {
  id: string;
  tenantId: string;
  name: string;
  phone?: string;
  email?: string;
  companyId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Company ──────────────────────────────────────────

export interface Company {
  id: string;
  tenantId: string;
  name: string;
  industry?: string;
  website?: string;
  createdAt: string;
}

// ── Deal ─────────────────────────────────────────────

export interface Deal {
  id: string;
  tenantId: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  title: string;
  value: number; // in paise (integer, never float)
  currency: string;
  status: DealStatus;
  closeDateAt?: string;
  lostReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type DealStatus = 'open' | 'won' | 'lost';

// ── Task ─────────────────────────────────────────────

export interface Task {
  id: string;
  tenantId: string;
  assignedTo: string;
  entityType: 'lead' | 'contact' | 'deal';
  entityId: string;
  title: string;
  dueAt?: string;
  status: 'pending' | 'done' | 'cancelled';
  createdAt: string;
}

// ── Conversation & Message ────────────────────────────

export interface Conversation {
  id: string;
  tenantId: string;
  contactId?: string;
  channel: 'whatsapp' | 'email' | 'sms';
  status: 'open' | 'resolved';
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  createdAt: string;
}

// ── AI Types (mirrored from leadsetu-ai) ─────────────

export interface AIRequest {
  tenantId: string;
  userId: string;
  task: AITask;
  context: Record<string, unknown>;
  maxTokens?: number;
}

export type AITask =
  | 'lead_summary'
  | 'conversation_summary'
  | 'reply_draft'
  | 'lead_score'
  | 'next_action'
  | 'crm_qa'
  | 'workflow_draft';

export interface AIResponse {
  requestId: string;
  task: AITask;
  result: string;
  sources?: AISource[];
  model: string;
  tokensUsed: number;
  durationMs: number;
}

export interface AISource {
  entityType: string;
  entityId: string;
  excerpt: string;
}

// ── Standard API Error ───────────────────────────────

export interface APIError {
  error: string;
  code: string;
  message: string;
  correlationId: string;
}
