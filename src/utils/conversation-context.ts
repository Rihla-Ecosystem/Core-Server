import crypto from 'crypto';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export function deriveDeterministicMessageId(
  businessRequestId: string,
  role: 'user' | 'assistant',
  conversationId?: string,
): string {
  const seed = conversationId
    ? `rhila-msg:${conversationId}:${businessRequestId}:${role}`
    : `rhila-msg:${businessRequestId}:${role}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const timeLow = hash.slice(0, 8);
  const timeMid = hash.slice(8, 12);
  const timeHiAndVersion = '4' + hash.slice(13, 16);
  const clockSeqHiAndReserved = (parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0');
  const clockSeqLow = hash.slice(18, 20);
  const node = hash.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeqHiAndReserved}${clockSeqLow}-${node}`;
}

export async function validateConversationOwnership(userId: string, conversationId?: string): Promise<string | undefined> {
  if (!conversationId) return undefined;
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, 'Conversation not found');
  }
  return existing.id;
}

import { ConversationContextEventStatus } from '@prisma/client';

export interface PersistConversationContextInput {
  conversationId: string;
  businessRequestId: string;
  feature: string;
  userContent: string;
  assistantContent: string;
}

export async function createConversationContextEvent(
  input: PersistConversationContextInput,
): Promise<{ id: string; status: ConversationContextEventStatus } | null> {
  try {
    const event = await prisma.conversationContextEvent.upsert({
      where: {
        conversationId_businessRequestId_feature: {
          conversationId: input.conversationId,
          businessRequestId: input.businessRequestId,
          feature: input.feature,
        },
      },
      create: {
        conversationId: input.conversationId,
        businessRequestId: input.businessRequestId,
        feature: input.feature,
        userContent: input.userContent,
        assistantContent: input.assistantContent,
        status: 'PENDING',
      },
      update: {},
    });
    return { id: event.id, status: event.status };
  } catch (err) {
    console.error('[conversation-context] CONVERSATION_CONTEXT_PERSISTENCE_FAILED:', {
      conversationId: input.conversationId,
      businessRequestId: input.businessRequestId,
      feature: input.feature,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function materializeConversationContextEvent(input: {
  eventId?: string;
  conversationId: string;
  businessRequestId: string;
  userContent: string;
  assistantContent: string;
}): Promise<boolean> {
  const userMsgId = deriveDeterministicMessageId(input.businessRequestId, 'user', input.conversationId);
  const assistantMsgId = deriveDeterministicMessageId(input.businessRequestId, 'assistant', input.conversationId);

  try {
    await prisma.message.upsert({
      where: { id: userMsgId },
      create: {
        id: userMsgId,
        conversationId: input.conversationId,
        role: 'user',
        content: input.userContent,
      },
      update: {},
    });

    await prisma.message.upsert({
      where: { id: assistantMsgId },
      create: {
        id: assistantMsgId,
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.assistantContent,
      },
      update: {},
    });

    if (input.eventId) {
      await prisma.conversationContextEvent.update({
        where: { id: input.eventId },
        data: {
          status: 'MATERIALIZED',
          materializedAt: new Date(),
          lastError: null,
        },
      });
    }
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[conversation-context] Materialization degraded:', {
      conversationId: input.conversationId,
      businessRequestId: input.businessRequestId,
      error: errorMsg,
    });
    if (input.eventId) {
      try {
        await prisma.conversationContextEvent.update({
          where: { id: input.eventId },
          data: {
            status: 'FAILED',
            attemptCount: { increment: 1 },
            lastError: errorMsg,
          },
        });
      } catch {
        // Ignore failure to update event error state
      }
    }
    return false;
  }
}

export async function persistAndMaterializeConversationContext(
  input: PersistConversationContextInput,
): Promise<void> {
  const event = await createConversationContextEvent(input);
  if (!event) return;

  if (event.status === 'MATERIALIZED') return;

  // Bounded retry (max 2 attempts) for materializing messages
  let success = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    success = await materializeConversationContextEvent({
      eventId: event.id,
      conversationId: input.conversationId,
      businessRequestId: input.businessRequestId,
      userContent: input.userContent,
      assistantContent: input.assistantContent,
    });
    if (success) break;
  }
}

export async function repairConversationContextEvent(input: {
  conversationId: string;
  businessRequestId: string;
  feature: string;
}): Promise<boolean> {
  const event = await prisma.conversationContextEvent.findUnique({
    where: {
      conversationId_businessRequestId_feature: {
        conversationId: input.conversationId,
        businessRequestId: input.businessRequestId,
        feature: input.feature,
      },
    },
  });

  if (!event) {
    console.warn('[conversation-context] No ConversationContextEvent found to repair:', input);
    return false;
  }

  if (event.status === 'MATERIALIZED') {
    return true;
  }

  return await materializeConversationContextEvent({
    eventId: event.id,
    conversationId: event.conversationId,
    businessRequestId: event.businessRequestId,
    userContent: event.userContent,
    assistantContent: event.assistantContent,
  });
}

export async function persistContextMessagesIdempotently(input: {
  conversationId: string;
  businessRequestId: string;
  userContent: string;
  assistantContent: string;
}): Promise<void> {
  await materializeConversationContextEvent(input);
}

export function formatCompactImageSummary(name: string, category?: string | null, description?: string | null): string {
  const parts = [name];
  if (category) parts.push(`(${category})`);
  if (description) {
    const cleanDesc = description.replace(/\s+/g, ' ').trim();
    parts.push(`— ${cleanDesc.slice(0, 250)}`);
  }
  return `[Identified: ${parts.join(' ')}]`;
}
