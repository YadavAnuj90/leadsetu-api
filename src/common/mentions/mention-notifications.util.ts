import type { Db } from 'mongodb';
import { Types } from 'mongoose';

export type MentionEntityType = 'lead' | 'deal' | 'contact';

export interface DispatchMentionInput {
  db: Db;
  tenantId: string;
  authorUserId: string;
  authorName?: string;
  entityType: MentionEntityType;
  entityId: string;
  entityLabel: string;
  noteText: string;
  activityId?: string;
}

function normalizeHandle(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
}

/**
 * Parses `@RepName` mentions in timeline notes and records targeted bell
 * notifications for matched teammates in the same workspace.
 */
export async function dispatchMentionNotifications(
  input: DispatchMentionInput,
): Promise<number> {
  const text = String(input.noteText || '').trim();
  if (!text || !text.includes('@')) return 0;

  const rawTokens = Array.from(text.matchAll(/@([a-zA-Z0-9._-]{2,40})/g)).map(
    (m) => m[1].toLowerCase(),
  );
  if (rawTokens.length === 0) return 0;

  const tokenSet = new Set(rawTokens);
  const tenantOid = new Types.ObjectId(input.tenantId);

  interface MentionCandidateUser {
    _id: unknown;
    name?: string;
    email?: string;
    userCode?: string;
  }

  const users: MentionCandidateUser[] = (await input.db
    .collection('users')
    .find(
      { tenantId: tenantOid, isActive: { $ne: false } },
      { projection: { _id: 1, name: 1, email: 1, userCode: 1 } },
    )
    .toArray()
    .catch(() => [])) as MentionCandidateUser[];

  if (users.length === 0) return 0;

  const matchedUsers = users.filter((u) => {
    const uid = String(u._id);
    if (uid === input.authorUserId) return false;

    const fullName = String(u.name || '').trim();
    const compactName = normalizeHandle(fullName);
    const firstWord = normalizeHandle(fullName.split(/\s+/)[0] || '');
    const emailLocal = String(u.email || '')
      .split('@')[0]
      .toLowerCase();
    const userCode = String(u.userCode || '').trim();

    for (const token of tokenSet) {
      if (
        token === compactName ||
        (firstWord.length >= 2 && token === firstWord) ||
        (emailLocal && token === emailLocal) ||
        (userCode && token === userCode)
      ) {
        return true;
      }
    }
    return false;
  });

  if (matchedUsers.length === 0) return 0;

  const href =
    input.entityType === 'deal'
      ? `/deals/${input.entityId}`
      : input.entityType === 'contact'
        ? `/contacts/${input.entityId}`
        : `/leads/${input.entityId}`;

  const now = new Date();
  const cleanAuthor =
    input.authorName?.trim() || 'Teammate';
  const excerpt = text.length > 140 ? `${text.slice(0, 137)}...` : text;

  const docs = matchedUsers.map((u) => ({
    tenantId: tenantOid,
    mentionedUserId: new Types.ObjectId(String(u._id)),
    mentionedName: String(u.name || ''),
    authorId: Types.ObjectId.isValid(input.authorUserId)
      ? new Types.ObjectId(input.authorUserId)
      : input.authorUserId,
    authorName: cleanAuthor,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel || input.entityType,
    activityId: input.activityId || '',
    excerpt,
    href,
    createdAt: now,
  }));

  await input.db
    .collection('mention_notifications')
    .insertMany(docs)
    .catch(() => {});

  return docs.length;
}
