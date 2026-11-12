import { z } from 'zod'
import { AllowedSchema, RoleModelSchema, SourceInstanceSchema } from '../../policy.ts'
import type { Trigger } from '../../core/index.ts'

export const CHAT_KINDS = ['feishu', 'discord', 'wecom'] as const
export const ApplicationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  name: z.string().trim().min(1).max(100), enabled: z.boolean().default(true),
  repositories: z.array(z.string().min(1)).min(1).refine(ids => new Set(ids).size === ids.length, 'Duplicate repositories'),
  sources: z.partialRecord(z.enum(CHAT_KINDS), SourceInstanceSchema).default({}),
  allowed: z.partialRecord(z.enum(CHAT_KINDS), z.array(AllowedSchema)).default({}),
  model: RoleModelSchema.nullable().default(null),
}).strict()
export type ApplicationConfig = z.infer<typeof ApplicationSchema>
export interface Application extends ApplicationConfig { revision: number; health?: Record<string, import('../../sources/host.ts').Health> }
export interface ApplicationChild {
  repositoryId: string; ticketId: string; scope: string; purpose: 'investigate' | 'fix'; dependsOn: string[]; observed?: string
  result?: { state?: string; summary?: string; pr?: { number: number; url: string } }
  investigations?: string[]
}
export interface ApplicationTask {
  id: string; applicationId: string; sessionId: string; trigger: Trigger; repositories: string[];
  state: 'queued' | 'investigating' | 'waiting' | 'working' | 'ready' | 'blocked' | 'stopped';
  createdAt: string; updatedAt: string; version: number;
  retryAt?: number; failures?: number;
  deliveryError?: string; deliveryRetryAt?: number;
  messages: Trigger[]; children: ApplicationChild[]; summary: string; error?: string;
  reads: { repositoryId: string; revision: string; path: string }[];
  notifications: { id: string; text: string; sent?: boolean }[];
}
