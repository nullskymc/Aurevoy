<p align="center">
  <img src="../../apps/desktop/public/aurevoy-wordmark.svg" width="320" alt="Aurevoy" />
</p>

# Aurevoy

> *무엇을* 원하는지만 말하세요. *어떻게* 할지는 맡기세요.  
> 내 컴퓨터에서 돌아가는, 일을 끝까지 해내는 개인 AI 에이전트.

---

Aurevoy는 **로컬 데스크톱 에이전트**입니다(macOS 우선). 목표를 주면 계획·도구 호출·파일 작업·조사·코드 수정까지 진행합니다. 언제든 중단·승인·되돌리기가 가능합니다.

## 할 수 있는 일

```
"Downloads 의 PNG 를 WebP 로 변환해줘"
"React 19 breaking changes 를 조사해 마이그레이션 체크리스트를 써줘"
"이 프로젝트에 다크 모드를 추가해줘"
"이 노트를 주간 보고서로 정리해줘"
```

- **코드·파일** — 검색, 정밀 편집, 워크스페이스 경계  
- **리서치** — 웹 검색/가져오기(SSRF 방어), 선택적 browser skill  
- **멀티모달** — 이미지/파일 드래그, 필요 시 비전 모델  
- **기억·지식** — 선호 기억, 폴더 KB/RAG  
- **제어** — 중지, 도구 승인, 인라인 수정 후 재시도, 분기  

데이터는 기본적으로 기기 안에 머뭅니다. API 키는 본인 것(OpenAI 호환/Anthropic 등). 오픈 소스.

## 시작하기

1. **설치** — [Releases](../../releases) DMG  
2. **설정** — Provider / Base URL / 모델 / Key  
3. **대화** — 목표 입력; `/` 로 skill 목록

### 개발

```bash
# Node >= 22.19.0, Rust stable, macOS Xcode CLT
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy && npm install
npm run dev
npm run typecheck
```

[AGENTS.md](../../AGENTS.md) · [docs/](../)

## 스택

| 계층 | 기술 |
|---|---|
| 셸 | Tauri 2 |
| UI | React + TypeScript (`packages/web-ui`) |
| 엔진 | Node + Fastify + Pi Agent + SQLite |
| 통신 | 로컬 HTTP + SSE |
| 확장 | 내장 도구 + MCP + Skill |

[ARCHITECTURE](../ARCHITECTURE.md) · [ROADMAP](../ROADMAP.md)

## 현재 기능

계획·도구 · 다중 LLM Provider · auto/plan · 멀티턴/재개 ·  
인라인 편집 재시도/분기/압축 · 서브에이전트 · Skill · 웹 검색 ·  
멀티모달 · 프로젝트 · 이중 예산 · 장기 기억 + KB RAG · 설정·CI  

**진행 중:** 서명/자동 업데이트, 암시적 KB 회수, 평가·배포 경험.

---

MIT
