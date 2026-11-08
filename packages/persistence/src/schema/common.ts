import { text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/** Tenant and project scope carried by every project-owned table. */
export const scope = () => ({
  tenantId: text('tenant_id').notNull(),
  projectId: text('project_id').notNull(),
});

export const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Extensible detail the spec does not enumerate. Never put raw prompts or secrets here. */
export const detail = () => jsonb('detail').$type<Record<string, unknown>>().notNull().default({});
