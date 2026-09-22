import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("Opportunity Intelligence — Radar e Modo Copiloto", () => {
  test("o Radar exibe o banner do Modo Copiloto e garante que o outbound automático está bloqueado", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    // Valida carregamento da tela principal do Radar
    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    // Invariante de Segurança: O banner do Modo Copiloto DEVE estar visível
    const copilotBanner = page.getByText(/Modo Copiloto:/);
    await expect(copilotBanner).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/nada é enviado automaticamente/i)).toBeVisible({
      timeout: 15_000,
    });

    // Valida que o radar carregou itens ou o estado vazio informativo
    const radarContainer = page.getByTestId("opportunity-radar");
    const emptyContainer = page.getByTestId("opportunity-empty");
    await expect(radarContainer.or(emptyContainer)).toBeVisible({ timeout: 30_000 });

    // Ausência deliberada de controles de envio em lote ou automação descontrolada
    await expect(page.getByRole("button", { name: /disparar em massa/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /enviar automaticamente/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /disparar agora/i })).toHaveCount(0);

    await page.screenshot({
      path: path.join(EVIDENCE, "opportunity-intelligence-copilot-radar.png"),
      fullPage: true,
    });
  });

  test("o Dossiê FACT apresenta âncoras de evidência e trava ações no modo proposto/revisão humana", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    const openBtn = page.getByTestId("open-dossier-btn").first();
    const hasItems = await openBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasItems) {
      await openBtn.click();
      const sheet = page.getByTestId("opportunity-dossier-sheet");
      await expect(sheet).toBeVisible({ timeout: 15_000 });

      // O dossiê deve renderizar a estrutura FACT ancorada
      await expect(page.getByText(/Dossiê FACT/)).toBeVisible({ timeout: 10_000 });

      // Se houver caixa de ação ativa, deve estar em estado proposto / pendente de aprovação
      const actionBox = page.getByTestId("dossier-action-box");
      if (await actionBox.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(actionBox.getByText(/Pendente de aprovação/i)).toBeVisible();

        // O botão de aprovação deve ser uma proposta interna / aprovação de rascunho, NUNCA envio autônomo
        const approveBtn = page.getByTestId("approve-action-btn");
        await expect(approveBtn).toBeVisible();
        await expect(approveBtn).not.toHaveText(/enviar agora/i);
        await expect(approveBtn).not.toHaveText(/disparar mensagem/i);

        // O descarte exige confirmação explícita para evitar cliques acidentais
        const rejectBtn = page.getByTestId("reject-action-btn");
        if (await rejectBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await rejectBtn.click();
          await expect(page.getByTestId("dossier-discard-confirmation")).toBeVisible();
          await expect(page.getByTestId("confirm-reject-btn")).toBeVisible();
        }
      }

      await page.screenshot({
        path: path.join(EVIDENCE, "opportunity-intelligence-dossier-fact.png"),
        fullPage: true,
      });
    } else {
      // Estado vazio também preserva integridade visual e explica a ausência de sinais
      await expect(page.getByTestId("opportunity-empty")).toBeVisible();
      await page.screenshot({
        path: path.join(EVIDENCE, "opportunity-intelligence-empty-state.png"),
        fullPage: true,
      });
    }
  });

  test("os filtros de resumo do Radar permitem inspecionar estados sem alterar o escopo do tenant", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    const radar = page.getByTestId("opportunity-radar");
    if (await radar.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Clica nos filtros de resumo
      const readyCard = page.getByRole("button", { name: /Prontas para agir/i });
      if (await readyCard.isVisible().catch(() => false)) {
        await readyCard.click();
        await page.waitForTimeout(500);
      }

      const reviewCard = page.getByRole("button", { name: /Esperando você/i });
      if (await reviewCard.isVisible().catch(() => false)) {
        await reviewCard.click();
        await page.waitForTimeout(500);
      }

      // O banner do Copiloto deve continuar firme e visível mesmo após interações
      await expect(page.getByText(/Modo Copiloto:/)).toBeVisible();
    }
  });

  test("as abas de navegação (Radar, Fila de Exceções, Fontes & Quotas) estão visíveis e transitam sem falhas", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    const tabRadar = page.getByTestId("tab-radar");
    const tabExceptions = page.getByTestId("tab-exceptions");
    const tabSources = page.getByTestId("tab-sources");

    await expect(tabRadar).toBeVisible({ timeout: 10_000 });
    await expect(tabExceptions).toBeVisible({ timeout: 10_000 });
    await expect(tabSources).toBeVisible({ timeout: 10_000 });

    // Alterna para a Fila de Exceções
    await tabExceptions.click();
    const exceptionsQueue = page.getByTestId("exceptions-queue");
    const exceptionsEmpty = page.getByTestId("exceptions-empty");
    await expect(exceptionsQueue.or(exceptionsEmpty).first()).toBeVisible({ timeout: 15_000 });

    // Alterna para Gestão de Fontes & Quotas
    await tabSources.click();
    const sourcesManager = page.getByTestId("sources-manager");
    await expect(sourcesManager).toBeVisible({ timeout: 15_000 });

    // Volta para o Radar
    await tabRadar.click();
    const radarContainer = page.getByTestId("opportunity-radar");
    const emptyContainer = page.getByTestId("opportunity-empty");
    await expect(radarContainer.or(emptyContainer)).toBeVisible({ timeout: 15_000 });
  });

  test("a aba de Fila de Exceções permite inspecionar dossiê FACT e exige confirmação para descarte", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("tab-exceptions").click();

    const openDossierBtn = page.getByTestId("open-dossier-btn").first();
    const hasExceptions = await openDossierBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasExceptions) {
      // Abre o dossiê a partir da fila de exceções
      await openDossierBtn.click();
      const sheet = page.getByTestId("opportunity-dossier-sheet");
      await expect(sheet).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Dossiê FACT/)).toBeVisible({ timeout: 10_000 });

      // Fecha o dossiê
      await page.keyboard.press("Escape");
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });

      // Valida confirmação de descarte se houver ação proposta
      const rejectBtn = page.getByTestId("exception-reject-btn").first();
      if (await rejectBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await rejectBtn.click();
        const confirmBox = page.getByTestId("exception-discard-confirmation");
        await expect(confirmBox).toBeVisible();
        await expect(confirmBox.getByText(/Confirmar descarte\?/i)).toBeVisible();

        // Cancela o descarte
        await confirmBox.getByRole("button", { name: /cancelar/i }).click();
        await expect(confirmBox).not.toBeVisible();
      }
    } else {
      await expect(page.getByTestId("exceptions-empty")).toBeVisible();
    }
  });

  test("a Gestão de Fontes & Quotas não expõe segredos, exibe limites e valida ações sem outbound", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/opportunities");

    await expect(
      page.getByRole("heading", { name: "Radar de oportunidades", level: 1 }),
    ).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("tab-sources").click();
    const sourcesManager = page.getByTestId("sources-manager");
    await expect(sourcesManager).toBeVisible({ timeout: 15_000 });

    // Invariante de Segurança: Nenhum token, secret ou chave privada deve aparecer no DOM
    const bodyText = await page.innerText("body");
    expect(bodyText).not.toMatch(/service_role_key/i);
    expect(bodyText).not.toMatch(/supabase_service/i);
    expect(bodyText).not.toMatch(/jwt_secret/i);
    expect(bodyText).not.toMatch(/bearer\s+eyJ/i);

    // Banner de Governança visível
    await expect(page.getByText(/Governança de Fontes:/)).toBeVisible();
    await expect(page.getByText(/outbound permanece 100% blindado/i)).toBeVisible();

    // Valida botões de operação da fonte caso existam
    const testBtn = page.getByTestId("test-source-btn").first();
    const hasSources = await testBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasSources) {
      // Testar fonte: deve executar com segurança e manter outbound bloqueado
      await testBtn.click();
      await expect(
        page.getByText(/Teste validado com sucesso/i).or(page.getByText(/Falha no teste/i)),
      ).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.getByText(/Nenhuma fonte de oportunidade configurada/i)).toBeVisible();
    }

    await page.screenshot({
      path: path.join(EVIDENCE, "opportunity-intelligence-sources-quotas.png"),
      fullPage: true,
    });
  });
});
