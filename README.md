# what-did-i-do

GitHub Organization에서 내 커밋 기록을 수집하고, AI로 이력서를 생성하는 CLI 도구입니다.

## 요구사항

- Node.js 18+
- GitHub CLI (`gh`)
- Claude Code CLI (`claude`) - 이력서 생성 기능 사용 시

### GitHub CLI 설치

```bash
# macOS
brew install gh

# Windows
winget install GitHub.cli

# Linux
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md
```

### GitHub CLI 인증

```bash
gh auth login
```

### Claude Code 설치 (이력서 생성용)

```bash
npm install -g @anthropic-ai/claude-code
```

## 설치

```bash
pnpm install
```

## 사용법

```bash
# npm script
pnpm start

# 직접 실행
node app.mjs

# 글로벌 설치 후
npm link
what-did-i-do
```

## 기능

### 메뉴

| 메뉴 | 설명 |
|------|------|
| 커밋 수집하기 | GitHub 조직/개인 레포에서 커밋 수집 |
| 이력서 생성하기 | 수집된 커밋 기록으로 AI 이력서 생성 |
| 수집 후 바로 이력서 생성 | 위 두 작업을 연속 실행 |

### 커밋 수집

- 로그인된 GitHub 계정의 Organization 목록 자동 조회
- 화살표 키로 Organization 선택
- 과거 핸들/이메일 추가 검색 지원
- 모든 레포지토리에서 내 커밋 수집
- 커밋 일시 기준 정렬

### 이력서 생성

- 월별로 커밋 그룹화
- Claude AI로 각 월별 활동 요약
- 최종 이력서 마크다운 생성 (기술 역량 + 프로젝트 경험)

## 출력 파일

| 파일 패턴 | 설명 |
|-----------|------|
| `commits-{org}-{timestamp}.md` | 수집된 커밋 기록 |
| `resume-{timestamp}.md` | 생성된 이력서 |
| `.temp-repos-*` | 레포지토리 클론 임시 폴더 |
| `.temp-resume-parts-*` | 이력서 섹션 임시 폴더 |

## 커밋 파일 형식

| 일시 | 레포지토리 | 커밋 메시지 | 링크 |
|------|------------|-------------|------|
| 2026-01-07 12:30:45 | repo-name | 커밋 내용 | [링크](https://github.com/...) |
