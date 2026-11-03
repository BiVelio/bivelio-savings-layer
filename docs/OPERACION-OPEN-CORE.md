# Operación Open Core — qué cambió, por qué, y qué decide el fundador

Fecha: 2026-11-03 · Rama: trabajo local de `main` (commits 097bb3c, 1230f42, 572a547, f8565b7 y siguientes).

## El diagnóstico

El producto era técnicamente excelente y comercialmente inviable tal cual: el SDK y el
gateway eran **fail-closed** — sin `BIVELIO_SERVICE_KEY` ni una licencia verificada no
arrancaba nada, ni para probarlo. Para un desarrollador que acaba de oír hablar de la
capa, el primer contacto era un muro: crear cuenta, sacar dos claves, leer una LICENSE
comercial, y pagar por asiento antes de haber ahorrado un céntimo. LiteLLM, OpenRouter y
Portkey crecen con open core o freemium; nadie adopta asiduamente una caja cerrada en
2026.

## Qué cambia (lo funcional)

1. **SDK**: `createSavingsLayer({ provider })` sin `licenseKey` corre con el **gate
   Community** (`src/license/community.ts`): todas las palancas locales activas, cero
   telemetría, cero red. Una clave PRESENTE pero inválida/caducada/revocada sigue
   lanzando `LicenseError` (fail-closed real): solo su ausencia dejó de ser un error.
   La nube (metering, renovación, entitlements de org) solo existe con
   `serviceAccountKey`, igual que antes.
2. **Gateway**: arranca sin claves en **modo Community**: palancas locales armadas por
   defecto (TTL 1h→5m, elisión, modelo hermano, esfuerzo — canal de entitlements
   local), metering OFF, informes locales `/_bvsala` funcionando, nada sale a BiVelio.
   Con clave de servicio: comportamiento de siempre (entitlements de la org).
3. **Integraciones nuevas** (pedido explícito del fundador):
   - **Gemini CLI**: el gateway ahora habla el protocolo Gemini
     (`:generateContent`/`:streamGenerateContent`, SSE y JSON por líneas) y existe
     `bvsala gemini` (GOOGLE_GEMINI_BASE_URL). Antes: «NOT metered yet».
   - **Cursor**: receta real (Settings → Models → OpenAI API Base URL, BYOK).
   - **Proveedores chinos**: alias `--upstream deepseek | qwen | glm | moonshot |
     minimax | openrouter`, catálogo con filas para deepseek-flash/v4-pro (a PEAK,
     documentado), qwen3.8/3.7/flash/plus y glm-5.3(+flash); **DeepSeek reescribe
     automáticamente** el tráfico Anthropic a su endpoint `/anthropic` (Claude Code
     con DeepSeek sin tocar config). Moonshot y MiniMax quedan fuera del catálogo
     hasta poder leer sus páginas oficiales (la regla de la casa: un precio mal es
     peor que ninguno).
   - **Locales**: `--upstream ollama | vllm | lmstudio` (tráfico reenviado y logueado,
     sin metering en dólares: los modelos locales no tienen precio de lista).
4. **Onboarding**: `bvsala init` ya no exige claves (las pide como OPCIONALES),
   README reescrito (open core, 60 segundos, tabla Community vs Cloud), doctor con
   recetas para todo lo anterior.

## Qué decide el fundador (no lo toco sin orden)

1. **LICENSE**: el fichero sigue siendo el comercial. El código YA funciona sin clave
   (open core funcional), pero el texto legal no lo dice. Opciones: (a) Apache-2.0 para
   el paquete npm + términos comerciales solo para la nube/enterprise (lo que recomiendo
   para YC: LiteLLM y Kong lo hacen), (b) dual-license, (c) mantener la LICENSE actual y
   redactar una sección «Community». Mientras tanto el badge del README no miente:
   «telemetry off by default», sin afirmar licencia OSS.
2. **Web de precios** (savings.bivelio.com): las páginas de pricing dicen «Measure →
   Pro/Team por asiento». Con open core el discurso debe girar: gratis = la capa entera;
   de pago = panel de equipo, cachés compartidas, entitlements. Actualizar cuando se
   publique la versión.
3. **Versión de npm**: publicar como `1.0.0` (cambio de contrato: sin clave ya no es un
   error) o como `0.7.0`. El README/CHANGELOG deberían llevar una sección
   «Open-core transition».
4. **El gateway en Community arma las palancas por defecto** (TTL, etc.). Si se prefiere
   el comportamiento conservador (todo OFF sin licencia), es un `if` en
   `gateway/servidor.ts` (`palancasArmadas`).

## Qué queda pendiente (siguientes pasos, en orden)

1. **CI en Linux** para ver el estado real de la suite (aquí, en Windows, hay ~25
   ficheros que fallan por entorno — spawn de `tsx`, secrets de apps/web, migraciones
   con BBDD — que ya fallaban en el árbol original; ver `_research/test-baseline-1.log`
   vs `_research/test-baseline-stash.log`).
2. **A/B de precios y web** (punto 2 de arriba) cuando el fundador decida.
3. **Growth**: launch en HN («Show HN: cut your LLM bill, audited per request, zero
   telemetry»), guías de integración por agente (docs/terminales), Discord/telemetría de
   instalaciones vía el cloud opcional, design partners de YC.
4. **Paper v2**: el borrador mejorado está en `_research/paper-v2.md`.

## Estado de la suite (Windows, 2026-11-03)

- `pnpm run build` ✓ · `pnpm run typecheck` ✓
- `vitest run test/…`: todo lo que toca esta operación pasa en aislamiento (SDK,
  gateway, licencias, catálogo, Gemini, doctor, upstream, envoltorios).
- Los fallos restantes de la suite completa son los preexistentes del entorno Windows
  (mismos ficheros y mismos tests que en el árbol limpio) más flakiness de paralelismo.
