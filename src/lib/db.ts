import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. In dev, hot-reload would otherwise spawn many clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Soft-delete helper: standard filter to exclude archived rows. Domain services
 * spread this into their `where` clauses so deleted data stays out of queries
 * without losing history.
 */
export const notDeleted = { deletedAt: null } as const;
