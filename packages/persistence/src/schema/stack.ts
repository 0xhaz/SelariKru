import { foreignKey, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * A project's stack settings (docs/framework-tool-catalog.md §3): components, their per-category selections and the latest static detection. Metadata only: no column
 * holds a credential, a connection or a command in effect. The row is the project's stack lock, and `revision` rises with every owner write, so a stale write is refused.
 */
export const projectStacks = pgTable(
  'project_stacks',
  {
    ...scope(),
    revision: integer('revision').notNull().default(0),
    /** The catalog version the document was written against. */
    catalogVersion: text('catalog_version').notNull(),
    /** A `StackDocument`: components with every category explicit (Not decided, None or a selection), and the latest detection with each item's state. */
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);
