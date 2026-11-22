export type WorkspaceBusinessMode =
  | 'b2b'
  | 'msme'
  | 'b2c'
  | 'hybrid'
  | 'bpo'
  | 'education';

export type ContactAccountKind = 'business' | 'consumer';

export const WORKSPACE_BUSINESS_MODES: WorkspaceBusinessMode[] = [
  'b2b',
  'msme',
  'b2c',
  'hybrid',
  'bpo',
  'education',
];

export function normalizeBusinessMode(raw?: unknown): WorkspaceBusinessMode {
  const val = String(raw || '').trim().toLowerCase();
  if (
    val === 'b2b' ||
    val === 'msme' ||
    val === 'b2c' ||
    val === 'hybrid' ||
    val === 'bpo' ||
    val === 'education'
  ) {
    return val;
  }
  return 'b2b';
}

export function normalizeAccountKind(
  raw?: unknown,
  tenantBusinessMode?: WorkspaceBusinessMode,
): ContactAccountKind {
  if (raw === 'business' || raw === 'consumer') return raw;
  if (
    tenantBusinessMode === 'b2c' ||
    tenantBusinessMode === 'bpo' ||
    tenantBusinessMode === 'education'
  ) {
    return 'consumer';
  }
  return 'business';
}

export const DEFAULT_HIDDEN_MODULES_BY_MODE: Record<
  WorkspaceBusinessMode,
  string[]
> = {
  b2b: [],
  msme: ['aiWorkflows', 'documentVault'],
  b2c: ['documentVault', 'slaTickets'],
  hybrid: [],
  bpo: ['products', 'gstBilling', 'documentVault'],
  education: ['products', 'slaTickets'],
};
