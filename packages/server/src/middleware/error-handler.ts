// ──────────────────────────────────────────────
// Error Handler Middleware
// ──────────────────────────────────────────────
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export function errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  // Zod validation errors → 400
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "Validation Error",
      details: error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
  }

  // SQLite errors → 503 with actionable message
  const msg = error.message ?? "";
  if (msg.includes("SQLITE_READONLY") || msg.includes("readonly database")) {
    reply.log.error(error);
    return reply.status(503).send({
      error: "Database is read-only. Check file permissions on the data directory and database file.",
    });
  }
  if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
    reply.log.error(error);
    return reply.status(503).send({
      error: "Database is temporarily locked. Please try again.",
    });
  }

  // Known HTTP errors
  if (error.statusCode === 413) {
    return reply.status(413).send({
      error: "Imported file is too large. Profile imports support files up to 256 MB.",
    });
  }

  if (error.statusCode) {
    return reply.status(error.statusCode).send({
      error: error.message,
    });
  }

  // Unknown errors → 500
  reply.log.error(error);
  return reply.status(500).send({
    error: "Internal Server Error",
  });
}
