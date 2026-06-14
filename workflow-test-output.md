# Workflow Test Output

Data: 2026-06-14

## Resumo do Projeto

### 📁 Resumo do Projeto `drawers`

#### Estrutura de Arquivos Raiz

| Arquivo/Dir | Tamanho | Última modificação | Descrição |
|---|---|---|---|
| `packages/` | dir | Jun 14 | Código-fonte dos plugins (opencode + pi) |
| `docs/` | dir | Jun 14 | Documentação |
| `scripts/` | dir | Jun 14 | Scripts de build/smoke |
| `node_modules/` | dir | Jun 14 | Dependências |
| `README.md` | 6,4 KB | Jun 14 | Documentação principal |
| `CHANGELOG.md` | 16 KB | Jun 11 | Histórico de versões |
| `package.json` | 1,8 KB | Jun 14 | Manifesto do workspace Bun |
| `bun.lock` | 184 KB | Jun 14 | Lockfile Bun |
| `pnpm-lock.yaml` | 107 KB | Jun 9 | Lockfile pnpm legado |
| `biome.json` | 336 B | Jun 7 | Configuração do linter Biome |
| `tsconfig.base.json` | 382 B | Jun 6 | Configuração TypeScript base |
| `.releaserc.json` | 1 KB | Jun 14 | Configuração de release semântico |
| `.references/` | dir | Jun 13 | Referências externas |
| `.github/` | dir | Jun 7 | CI/CD GitHub Actions |
| `.claude/` | dir | Jun 11 | Skills para Claude Code |
| `.opencode/` | dir | Jun 7 | Configuração opencode |

---

#### 🗂️ O que é o Projeto

**`drawers`** é um **monorepo Bun workspace** que contém plugins independentemente instaláveis para dois AI agent harnesses:

- **[opencode](https://opencode.ai)** → plugins em `packages/opencode/`
- **[pi](https://pi.dev)** → extensões em `packages/pi/`

---

#### 📦 Plugins Disponíveis

##### Para **opencode** (compartilham `@drawers/core`):

| Plugin | Ferramentas |
|---|---|
| `opencode-drawer-agents` | `bg_task`, `bg_output`, `bg_cancel`, `bg_list` — agentes background fire-and-forget |
| `opencode-drawer-workflows` | `workflow`, `workflow_status`, `workflow_stop`, `workflow_save_run` — orquestração multi-agente determinística |
| `opencode-drawer-cadence` | `loop`, `goal`, `cadence_stop`, `cadence_list` — re-prompting na sessão com intervalos ou goals |
| `opencode-drawer-statusline` | Status line compacta no terminal (dir, branch, versão, etc.) |

##### Para **pi** (compartilham `@drawers/pi-core`):

| Plugin | Ferramentas |
|---|---|
| `pi-drawer-agents` | `bg_task`, `bg_output`, `bg_cancel`, `bg_list` |
| `pi-drawer-workflows` | `workflow`, `workflow_status`, `workflow_stop`, `workflow_save` |
| `pi-drawer-cadence` | `loop`, `goal`, `cadence_stop`, `cadence_list` |
| `pi-drawer-statusline` | Status line no footer do pi |

---

#### 🛠️ Comandos de Desenvolvimento

```bash
bun install          # instala dependências
bun test             # suite de testes
bun run typecheck    # TypeScript check
bun run lint         # Biome linter
bun run smoke:pi-agents    # testes de fumaça pi
bun run smoke:workflows    # testes de fumaça opencode
```

---

#### 🔑 Highlights

- **Arquitetura**: Cada plugin é publicado e instalado independentemente, mas compartilham engines (`@drawers/core` para opencode, `@drawers/pi-core` para pi)
- **Skills Claude Code**: `.claude/skills/opencode-plugin-dev` e `pi-plugin-dev` para criar novos drawers
- **Licença**: MIT
- **Repositório ativo**: última modificação em **Jun 14, 2026** (hoje)

---

## Status

✅ Workflow executado com sucesso!
