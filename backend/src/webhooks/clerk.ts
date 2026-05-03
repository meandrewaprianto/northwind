import type { Request, Response } from "express";
import { getEnv } from "../lib/env";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { parseRole } from "../lib/roles";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { error } from "node:console";

export async function clerkWebhookHandler(req: Request, res: Response) {
  const env = getEnv();

  let evt: Awaited<ReturnType<typeof verifyWebhook>>;

  try {
    if (!env.CLERK_WEBHOOK_SECRET) {
      res.status(503).send("Webhooks secret is not provided");
      return;
    }

    //Clerk's verifier expects a Web Request with the Raw Body; Express may give Buffer or string.
    const payload =
      req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body);

    const request = new Request("http://internal/webhooks/clerk", {
      method: "POST",
      headers: new Headers(req.headers as HeadersInit),
      body: payload,
    });

    // throws if signature is wrong or body was tampered with; only then we trust evt
    evt = await verifyWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SECRET,
    });
  } catch {
    console.error("Clerk webhook signature verification failed", error);
    res.status(400).json({ error: "Invalid Webhook" });
    return;
  }

  try {
    if (evt.type === "user.created" || evt.type === "user.updated") {
      const u = evt.data;

      const email =
        u.email_addresses?.find((e) => e.id === u.primary_email_address_id)
          ?.email_address ?? u.email_addresses?.[0]?.email_address;

      const displayName =
        [u.first_name, u.last_name].filter(Boolean).join(" ") ||
        u.username ||
        null;

      const role = parseRole(u.public_metadata?.role);

      await db
        .insert(users)
        .values({
          clerkUserId: u.id,
          email,
          displayName,
          role,
        })
        .onConflictDoUpdate({
          target: users.clerkUserId,
          set: { email, displayName, role, updatedAt: new Date() },
        });
    }

    if (evt.type === "user.deleted") {
      const id = evt.data.id;
      if (id) {
        await db.delete(users).where(eq(users.clerkUserId, id));
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Clerk webhook error", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
