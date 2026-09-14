import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const password = "AtendeProQa!2026#Deskcomm";
const email = `atendepro-${randomUUID().slice(0, 8)}@qa.local`;
let userId = "";
let organizationId = "";

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  const { data: user, error: userError } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("usuário E2E não criado");
  userId = user.user.id;

  const { data: organization, error: organizationError } = await svc
    .from("organizations")
    .insert({
      slug: `atendepro-${randomUUID().slice(0, 8)}`,
      display_name: "Empresa AtendePro E2E",
      legal_name: "Empresa AtendePro E2E",
      status: "active",
      created_by: userId,
      settings: { llm: { provider: "anthropic" } },
    })
    .select("id")
    .single();
  if (organizationError || !organization) {
    throw organizationError ?? new Error("organização E2E não criada");
  }
  organizationId = organization.id as string;

  const { error: membershipError } = await svc.from("user_organizations").insert({
    organization_id: organizationId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (membershipError) throw membershipError;
});

test.afterAll(async () => {
  if (organizationId) {
    const removeByOrganization = async (table: string) => {
      await svc.from(table).delete().eq("organization_id", organizationId);
    };
    for (const table of [
      "messages",
      "ai_agent_runs",
      "ai_agent_versions",
      "conversations",
      "contacts",
      "channel_sessions",
      "ai_agents",
      "org_memory_pointers",
      "org_memory_versions",
      "crm_stages",
      "crm_pipelines",
      "event_log",
      "api_audit_log",
      "user_organizations",
    ]) {
      await removeByOrganization(table);
    }
    await svc.from("organizations").delete().eq("id", organizationId);
  }
  if (userId) await svc.auth.admin.deleteUser(userId);
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
}

test("onboarding → simulador → persistência segura no CRM", async ({ page, baseURL }) => {
  const browserExternalRequests: string[] = [];
  const allowedOrigins = new Set([
    new URL(baseURL ?? "http://localhost:3001").origin,
    new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin,
  ]);
  page.on("request", (request) => {
    const url = request.url();
    if (!allowedOrigins.has(new URL(url).origin)) {
      browserExternalRequests.push(url);
    }
  });

  await login(page);
  await page.waitForURL(/\/onboarding\/welcome/);
  await page.locator("#display_name").fill("Empresa AtendePro E2E");
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /^continuar$/i }).click();

  await page.waitForURL(/\/onboarding\/connect-whatsapp/);
  await page.getByRole("button", { name: /usar simulador local/i }).click();
  await page.waitForURL(/\/onboarding\/setup-ai/);

  await page.locator("#name").fill("Atendente Virtual E2E");
  await page.locator("#regras_da_casa").fill("Nunca prometa desconto; ofereça horários concretos.");
  await page.getByRole("button", { name: /criar e continuar/i }).click();

  const avançouParaFunil = await Promise.race([
    page.waitForURL(/\/onboarding\/funil/, { timeout: 30_000 }).then(() => true),
    page
      .getByRole("button", { name: /continuar sem publicar/i })
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => false),
  ]).catch(() => false);
  if (!avançouParaFunil) {
    await expect(page.getByRole("alert").first()).toContainText(/rascunho/i);
    await page.getByRole("button", { name: /continuar sem publicar/i }).click();
    await page.waitForURL(/\/onboarding\/funil/);
  }

  await page.getByRole("button", { name: /usar este quadro/i }).click();
  await page.waitForURL(/\/onboarding\/testar/);
  await page.getByRole("button", { name: /^continuar$/i }).click();
  await page.waitForURL(/\/onboarding\/invite-team/);
  await page.getByRole("button", { name: /pular por enquanto/i }).click();
  await page.waitForURL(/\/onboarding\/done/);
  await page.getByRole("button", { name: /começar a usar/i }).click();
  await page.waitForURL(/\/app\//);

  const { data: member } = await svc
    .from("user_organizations")
    .select("interface_settings")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .single();
  expect(member?.interface_settings).toMatchObject({ preset: "simplificada" });

  await page.goto("/app/inbox");
  const openSimulator = page
    .getByRole("button", { name: /abrir simulador local|simulador/i })
    .first();
  await expect(openSimulator).toBeVisible();
  await openSimulator.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/modo local.*sem egressos/i);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/simulator/messages") &&
      response.request().method() === "POST",
  );
  await dialog.locator("#simulador-input").fill("Quero agendar um horário para amanhã");
  await dialog.getByRole("button", { name: /enviar mensagem simulada/i }).click();
  const simulatorResponse = await responsePromise;
  expect(simulatorResponse.status()).toBe(201);
  await expect(dialog.getByText(/atendente virtual/i).last()).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Simulação local", { exact: true }).first()).toBeVisible();

  const { data: session } = await svc
    .from("channel_sessions")
    .select("provider, simulator_session_key, waha_session_name")
    .eq("organization_id", organizationId)
    .single();
  expect(session).toMatchObject({ provider: "simulator", waha_session_name: null });
  expect(session?.simulator_session_key).toBe(`atendepro-local-${organizationId}`);

  const { data: conversation } = await svc
    .from("conversations")
    .select("id, channel")
    .eq("organization_id", organizationId)
    .eq("channel", "simulator")
    .single();
  expect(conversation?.id).toBeTruthy();

  const { data: messages } = await svc
    .from("messages")
    .select("direction, status, sent_via, metadata, conversation_id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversation!.id)
    .order("created_at", { ascending: true });
  expect(messages).toHaveLength(2);
  expect(messages?.[0]).toMatchObject({
    direction: "inbound",
    status: "received",
    sent_via: "user",
  });
  expect(messages?.[1]).toMatchObject({
    direction: "outbound",
    status: "delivered",
    sent_via: "ai",
    metadata: { simulated: true, zero_egress: true },
  });

  const { count: externalSessions } = await svc
    .from("channel_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("provider", ["waha", "meta_cloud", "zernio", "wacalls"]);
  expect(externalSessions).toBe(0);
  expect(browserExternalRequests).toEqual([]);
});
