#!/usr/bin/env node

import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { homedir } from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const execAsync = promisify(exec);
const CONCURRENCY_LIMIT = 3;

const COLORS = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[90m',
  cyan: '\x1B[36m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  red: '\x1B[31m',
  underline: '\x1B[4m'
};

const clear = () => process.stdout.write('\x1B[2J\x1B[H');
const clearLine = () => process.stdout.write('\x1B[2K\r');
const moveCursorUp = (n) => process.stdout.write(`\x1B[${n}A`);
const hideCursor = () => process.stdout.write('\x1B[?25l');
const showCursor = () => process.stdout.write('\x1B[?25h');

function execCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
  } catch {
    return null;
  }
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const promise = task().then((result) => {
      executing.delete(promise);
      return result;
    });
    results.push(promise);
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

function select(message, choices) {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    hideCursor();

    const render = (isInitial = false) => {
      if (!isInitial) {
        moveCursorUp(choices.length);
      }
      choices.forEach((choice, index) => {
        clearLine();
        const prefix = index === selectedIndex ? `${COLORS.cyan}❯` : ' ';
        const text = index === selectedIndex ? `${COLORS.cyan}${choice.name}` : `${COLORS.dim}${choice.name}`;
        console.log(`${prefix} ${text}${COLORS.reset}`);
      });
    };

    console.log(`${COLORS.bold}${message}${COLORS.reset}\n`);
    render(true);

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      showCursor();
    };

    const onKeypress = (_, key) => {
      if (key.name === 'up') {
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : choices.length - 1;
        render();
      } else if (key.name === 'down') {
        selectedIndex = selectedIndex < choices.length - 1 ? selectedIndex + 1 : 0;
        render();
      } else if (key.name === 'return') {
        cleanup();
        process.stdin.pause();
        moveCursorUp(choices.length + 2);
        for (let i = 0; i < choices.length + 2; i++) {
          clearLine();
          console.log('');
        }
        moveCursorUp(choices.length + 2);
        console.log(`${COLORS.green}✔${COLORS.reset} ${message}: ${COLORS.cyan}${choices[selectedIndex].name}${COLORS.reset}\n`);
        resolve(choices[selectedIndex].value);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        process.stdin.pause();
        clear();
        process.exit(0);
      }
    };

    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
  });
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function checkGhCli() {
  const ghVersion = execCommand('gh --version');
  if (!ghVersion) {
    console.error(`${COLORS.red}✘ GitHub CLI(gh)가 설치되어 있지 않습니다.${COLORS.reset}\n`);
    console.error('설치 방법:');
    console.error('  macOS:   brew install gh');
    console.error('  Windows: winget install GitHub.cli');
    console.error('  Linux:   https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n');
    process.exit(1);
  }

  const authStatus = execCommand('gh auth status');
  if (!authStatus) {
    console.error(`${COLORS.red}✘ GitHub CLI 인증이 필요합니다.${COLORS.reset}\n`);
    console.error('다음 명령어를 실행해주세요:');
    console.error('  gh auth login\n');
    process.exit(1);
  }
}

function getGitHubUser() {
  const result = execCommand('gh api user --jq .login');
  if (!result) {
    console.error(`${COLORS.red}✘ GitHub 사용자 정보를 가져올 수 없습니다.${COLORS.reset}\n`);
    process.exit(1);
  }
  return result;
}

function getUserOrganizations() {
  const result = execCommand('gh api user/orgs --jq ".[].login"');
  if (!result) {
    return [];
  }
  return result.split('\n').filter(Boolean);
}

function getOrgRepos(org) {
  const result = execCommand(
    `gh repo list ${org} --limit 1000 --json name,url,sshUrl --jq '.[] | "\\(.name)|\\(.url)"'`
  );
  if (!result) {
    return [];
  }
  return result.split('\n').filter(Boolean).map((line) => {
    const [name, url] = line.split('|');
    return { name, url };
  });
}

function getUserEmail() {
  return execCommand('git config user.email') || '';
}

async function cloneAndGetCommits(repo, org, authors, tempDir) {
  const repoPath = path.join(tempDir, repo.name);
  const cloneUrl = `https://github.com/${org}/${repo.name}.git`;

  try {
    await execAsync(`git clone --quiet --filter=blob:none "${cloneUrl}" "${repoPath}"`, {
      timeout: 120000
    });
  } catch {
    return [];
  }

  const authorFilters = authors.map((a) => `--author="${a}"`).join(' ');

  let commits;
  try {
    const { stdout } = await execAsync(
      `git log --all ${authorFilters} --format="%H<|>%s<|>%aI" --date=iso`,
      { cwd: repoPath, maxBuffer: 500 * 1024 * 1024, timeout: 60000 }
    );
    commits = stdout.trim();
  } catch {
    fs.rmSync(repoPath, { recursive: true, force: true });
    return [];
  }

  if (!commits) {
    fs.rmSync(repoPath, { recursive: true, force: true });
    return [];
  }

  const commitLines = commits.split('\n').filter(Boolean);
  const result = [];

  for (const line of commitLines) {
    const parts = line.split('<|>');
    if (parts.length < 3) continue;

    const hash = parts[0];
    const message = parts[1];
    const date = parts[2];

    result.push({
      hash,
      message,
      date,
      repoName: repo.name,
      repoUrl: repo.url
    });
  }

  fs.rmSync(repoPath, { recursive: true, force: true });
  return result;
}

async function collectCommits() {
  console.log(`${COLORS.bold}=== GitHub 커밋 수집 ===${COLORS.reset}\n`);

  checkGhCli();

  clearLine();
  process.stdout.write('GitHub 사용자 정보 확인 중...');
  const username = getGitHubUser();
  const userEmail = getUserEmail();
  clearLine();
  console.log(`${COLORS.green}✔${COLORS.reset} 사용자: ${COLORS.cyan}${username}${COLORS.reset} ${userEmail ? `(${userEmail})` : ''}\n`);

  const authors = [username];
  if (userEmail) {
    authors.push(userEmail);
  }

  console.log(`${COLORS.dim}예: old-username, old@email.com${COLORS.reset}`);
  const extraAuthors = await prompt('추가 검색할 이메일/핸들 (없으면 Enter): ');
  if (extraAuthors) {
    extraAuthors.split(',').map((a) => a.trim()).filter(Boolean).forEach((a) => authors.push(a));
  }
  console.log(`${COLORS.green}✔${COLORS.reset} 검색 대상: ${authors.join(', ')}\n`);

  clearLine();
  process.stdout.write('조직 목록을 가져오는 중...');
  const orgs = getUserOrganizations().sort((a, b) => a.localeCompare(b));
  clearLine();
  console.log(`${COLORS.green}✔${COLORS.reset} ${orgs.length}개의 조직 발견\n`);

  const choices = [
    { name: `${username} (개인 레포지토리)`, value: username },
    ...orgs.map((org) => ({ name: org, value: org }))
  ];

  const org = await select('조직 선택', choices);

  clearLine();
  process.stdout.write(`${org}의 레포지토리 목록을 가져오는 중...`);
  const repos = getOrgRepos(org);
  clearLine();

  if (repos.length === 0) {
    console.log(`${COLORS.red}✘${COLORS.reset} 레포지토리를 찾을 수 없습니다.\n`);
    return null;
  }

  console.log(`${COLORS.green}✔${COLORS.reset} ${repos.length}개의 레포지토리 발견\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFile = path.join(process.cwd(), `commits-${org}-${timestamp}.md`);

  const tempDir = path.join(process.cwd(), `.temp-repos-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const allCommits = [];

  const writeHeader = () => {
    fs.writeFileSync(outputFile, `# ${org} - ${username}의 커밋 기록\n\n`);
    fs.appendFileSync(outputFile, `생성일시: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n\n`);
    fs.appendFileSync(outputFile, `| 일시 | 레포지토리 | 커밋 메시지 | 링크 |\n`);
    fs.appendFileSync(outputFile, `|------|------------|-------------|------|\n`);
  };

  const formatCommit = (commit) => {
    const d = new Date(commit.date);
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const formattedDate = kst.toISOString().replace('T', ' ').slice(0, 19);
    const commitUrl = `${commit.repoUrl}/commit/${commit.hash}`;
    return `| ${formattedDate} | ${commit.repoName} | ${commit.message.replace(/\|/g, '\\|')} | [링크](${commitUrl}) |\n`;
  };

  const writeAllCommits = () => {
    writeHeader();
    const sorted = [...allCommits].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    for (const commit of sorted) {
      fs.appendFileSync(outputFile, formatCommit(commit));
    }
  };

  writeHeader();

  const total = repos.length;
  let completed = 0;

  process.stdout.write(`${COLORS.dim}[0/${total}] 검색 중...${COLORS.reset}`);

  const results = await Promise.all(
    repos.map(async (repo) => {
      const commits = await cloneAndGetCommits(repo, org, authors, tempDir);
      completed++;

      clearLine();
      if (commits.length > 0) {
        console.log(`${COLORS.green}● ${repo.name}${COLORS.reset} → ${commits.length}개`);
      }
      process.stdout.write(`${COLORS.dim}[${completed}/${total}] 검색 중...${COLORS.reset}`);

      return { repo, commits };
    })
  );

  clearLine();
  console.log(`${COLORS.green}✔${COLORS.reset} ${total}개 레포지토리 검색 완료`);

  for (const { commits } of results) {
    if (commits.length > 0) {
      allCommits.push(...commits);
    }
  }

  writeAllCommits();

  console.log('');
  console.log(`${COLORS.bold}=== 수집 완료 ===${COLORS.reset}`);
  console.log(`총 ${COLORS.cyan}${allCommits.length}개${COLORS.reset}의 커밋을 발견했습니다.`);
  console.log(`결과 파일: ${COLORS.underline}${outputFile}${COLORS.reset}\n`);

  return outputFile;
}

function findClaudePath() {
  const home = homedir();

  const scanDir = (baseDir, pattern, subPath) => {
    if (!fs.existsSync(baseDir)) return [];
    try {
      return fs.readdirSync(baseDir)
        .filter(pattern)
        .map((dir) => path.join(baseDir, dir, subPath));
    } catch {
      return [];
    }
  };

  const getDynamicPaths = () => {
    const paths = [];
    paths.push(...scanDir(path.join(home, '.nvm/versions/node'), (d) => d.startsWith('v'), 'bin/claude'));
    paths.push(...scanDir(path.join(home, 'Library/Application Support/fnm/node-versions'), (d) => d.startsWith('v'), 'installation/bin/claude'));
    paths.push(...scanDir(path.join(home, '.local/share/fnm/node-versions'), (d) => d.startsWith('v'), 'installation/bin/claude'));
    paths.push(...scanDir(path.join(home, '.fnm/node-versions'), (d) => d.startsWith('v'), 'installation/bin/claude'));
    paths.push(...scanDir('/opt/homebrew/Cellar/node', () => true, 'bin/claude'));
    paths.push(...scanDir('/usr/local/Cellar/node', () => true, 'bin/claude'));
    paths.push(...scanDir(path.join(home, '.volta/tools/image/node'), () => true, 'bin/claude'));
    paths.push(...scanDir(path.join(home, '.asdf/installs/nodejs'), () => true, 'bin/claude'));
    return paths;
  };

  const staticPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
    path.join(home, '.npm-global/bin/claude'),
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    path.join(home, 'n/bin/claude')
  ];

  const allPaths = [...staticPaths, ...getDynamicPaths()];

  for (const candidatePath of allPaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const isMac = process.platform === 'darwin';
  if (isMac) {
    try {
      const foundPath = execSync('/bin/zsh -lc "which claude"', { encoding: 'utf8', timeout: 5000 }).trim();
      if (foundPath) return foundPath.split('\n')[0].trim();
    } catch { /* ignore */ }
    try {
      const foundPath = execSync('/bin/bash -lc "which claude"', { encoding: 'utf8', timeout: 5000 }).trim();
      if (foundPath) return foundPath.split('\n')[0].trim();
    } catch { /* ignore */ }
  } else {
    try {
      const foundPath = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
      if (foundPath) return foundPath.split('\n')[0].trim();
    } catch { /* ignore */ }
  }

  return null;
}

function getCommitsFiles() {
  const cwd = process.cwd();
  const files = fs.readdirSync(cwd).filter((file) => file.startsWith('commits-') && file.endsWith('.md'));
  return files.map((file) => ({
    name: file,
    path: path.join(cwd, file)
  }));
}

function parseCommitsMarkdown(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const commits = [];
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| 일시 |')) {
      inTable = true;
      continue;
    }
    if (line.startsWith('|------')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 4) {
        const dateStr = parts[0];
        const repo = parts[1];
        const message = parts[2].replace(/\\\|/g, '|');
        const linkMatch = parts[3].match(/\[링크\]\((.*?)\)/);
        const link = linkMatch ? linkMatch[1] : '';

        commits.push({
          date: dateStr,
          repo,
          message,
          link
        });
      }
    }
  }

  return commits;
}

function groupCommitsByYearMonth(commits) {
  const groups = new Map();

  for (const commit of commits) {
    const dateMatch = commit.date.match(/^(\d{4})-(\d{2})/);
    if (dateMatch) {
      const yearMonth = `${dateMatch[1]}-${dateMatch[2]}`;
      if (!groups.has(yearMonth)) {
        groups.set(yearMonth, []);
      }
      groups.get(yearMonth).push(commit);
    }
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
  const sortedGroups = new Map();
  for (const key of sortedKeys) {
    sortedGroups.set(key, groups.get(key));
  }

  return sortedGroups;
}

async function callClaude(claudePath, promptText, cwd) {
  const options = {
    cwd,
    pathToClaudeCodeExecutable: claudePath,
    systemPrompt: {
      type: 'preset',
      preset: 'default'
    },
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions'
  };

  const queryResult = query({
    prompt: promptText,
    options
  });

  let resultText = '';
  const DEBUG = process.env.DEBUG === '1';

  for await (const message of queryResult) {
    if (DEBUG) {
      console.log('[DEBUG]', message.type, JSON.stringify(message).substring(0, 500));
    }
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            resultText = block.text;
          }
        }
      } else if (typeof content === 'string') {
        resultText = content;
      }
    } else if (message.type === 'result') {
      if (message.is_error && message.errors) {
        throw new Error(message.errors.join('\n'));
      }
    }
  }

  if (!resultText.trim()) {
    throw new Error('Claude 응답이 비어있습니다');
  }

  let cleaned = resultText.trim();
  cleaned = cleaned.replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```$/i, '');
  return cleaned.trim();
}

function formatCommitsForPrompt(yearMonth, commits) {
  const [year, month] = yearMonth.split('-');
  let text = `## ${year}년 ${parseInt(month)}월 활동 내역\n\n`;

  const repoGroups = new Map();
  for (const commit of commits) {
    if (!repoGroups.has(commit.repo)) {
      repoGroups.set(commit.repo, []);
    }
    repoGroups.get(commit.repo).push(commit);
  }

  for (const [repo, repoCommits] of repoGroups) {
    text += `### ${repo}\n`;
    for (const commit of repoCommits) {
      text += `- ${commit.message}\n`;
    }
    text += '\n';
  }

  return text;
}

async function generateResumeSection(claudePath, yearMonth, commits, cwd) {
  const commitsText = formatCommitsForPrompt(yearMonth, commits);

  const promptText = `아래 커밋 기록을 이력서용 bullet point 3-5개로 요약해.

규칙:
- 설명 없이 바로 "-"로 시작
- 각 항목에 [레포명] 포함
- 기술스택 언급
- 한국어

예시:
- [exif-frame] EXIF 메타데이터 처리 기능 개선 (JavaScript, Canvas API)

${commitsText}

출력:`;

  return await callClaude(claudePath, promptText, cwd);
}

async function generateFinalResume(claudePath, sections, cwd) {
  const allSections = sections.map((s) => `## ${s.yearMonth}\n${s.content}`).join('\n\n');

  const promptText = `아래 월별 개발 활동을 기반으로 이력서를 작성해.

형식:
# 기술 역량
(사용한 기술스택을 카테고리별로 정리)

# 프로젝트 경험
([레포명]을 프로젝트 단위로 인식해서 ## 레포명 형태로 묶어서 성과 중심 정리)

규칙:
- 코드블록(\`\`\`) 사용 금지
- 바로 # 기술 역량 으로 시작
- 한국어

${allSections}`;

  return await callClaude(claudePath, promptText, cwd);
}

async function generateResume(commitsFilePath = null) {
  console.log(`${COLORS.bold}=== 이력서 생성 ===${COLORS.reset}\n`);

  const claudePath = findClaudePath();
  if (!claudePath) {
    console.error(`${COLORS.red}✘ Claude CLI를 찾을 수 없습니다.${COLORS.reset}`);
    console.error('Claude Code를 설치해주세요: https://claude.ai/code\n');
    return;
  }
  console.log(`${COLORS.green}✔${COLORS.reset} Claude CLI: ${COLORS.dim}${claudePath}${COLORS.reset}\n`);

  let selectedFilePath = commitsFilePath;

  if (!selectedFilePath) {
    const commitsFiles = getCommitsFiles();
    if (commitsFiles.length === 0) {
      console.error(`${COLORS.red}✘ commits-*.md 파일을 찾을 수 없습니다.${COLORS.reset}`);
      console.error('먼저 "커밋 수집하기"를 실행하여 커밋 기록을 수집해주세요.\n');
      return;
    }

    const choices = commitsFiles.map((file) => ({
      name: file.name,
      value: file
    }));

    const selectedFile = await select('커밋 파일 선택', choices);
    selectedFilePath = selectedFile.path;
  }

  console.log(`${COLORS.dim}파일 파싱 중...${COLORS.reset}`);
  const commits = parseCommitsMarkdown(selectedFilePath);
  console.log(`${COLORS.green}✔${COLORS.reset} ${commits.length}개의 커밋 발견\n`);

  const groupedCommits = groupCommitsByYearMonth(commits);
  console.log(`${COLORS.green}✔${COLORS.reset} ${groupedCommits.size}개의 년월 그룹으로 분류\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = path.join(process.cwd(), `.temp-resume-parts-${timestamp}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const total = groupedCommits.size;
  let completed = 0;

  console.log(`${COLORS.bold}이력서 섹션 생성 중...${COLORS.reset}\n`);
  process.stdout.write(`${COLORS.dim}[0/${total}] 처리 중...${COLORS.reset}`);

  const tasks = [...groupedCommits.entries()].map(([yearMonth, monthCommits]) => async () => {
    try {
      const sectionContent = await generateResumeSection(claudePath, yearMonth, monthCommits, process.cwd());

      if (!sectionContent || !sectionContent.trim()) {
        throw new Error('빈 응답');
      }

      const sectionFile = path.join(outputDir, `${yearMonth}.md`);
      fs.writeFileSync(sectionFile, sectionContent.trim());

      completed++;
      clearLine();
      console.log(`${COLORS.green}✔${COLORS.reset} ${yearMonth} 완료`);
      process.stdout.write(`${COLORS.dim}[${completed}/${total}] 처리 중...${COLORS.reset}`);

      return {
        yearMonth,
        content: sectionContent.trim(),
        file: sectionFile
      };
    } catch (error) {
      completed++;
      clearLine();
      console.log(`${COLORS.red}✘${COLORS.reset} ${yearMonth} 실패: ${error.message}`);
      process.stdout.write(`${COLORS.dim}[${completed}/${total}] 처리 중...${COLORS.reset}`);
      return null;
    }
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);
  const sections = results.filter(Boolean).sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));

  clearLine();

  console.log(`\n${COLORS.bold}최종 이력서 생성 중...${COLORS.reset}`);

  try {
    const finalResume = await generateFinalResume(claudePath, sections, process.cwd());
    const finalFile = path.join(process.cwd(), `resume-${timestamp}.md`);
    fs.writeFileSync(finalFile, finalResume);

    console.log(`\n${COLORS.bold}=== 완료 ===${COLORS.reset}`);
    console.log(`최종 이력서: ${COLORS.underline}${finalFile}${COLORS.reset}\n`);
  } catch (error) {
    console.error(`${COLORS.red}✘ 최종 이력서 생성 실패:${COLORS.reset} ${error.message}\n`);
  }
}

async function main() {
  clear();
  console.log(`${COLORS.bold}=== GitHub 커밋 기반 이력서 생성기 ===${COLORS.reset}\n`);

  const menuChoices = [
    { name: '📥 커밋 수집하기', value: 'collect' },
    { name: '📝 이력서 생성하기', value: 'generate' },
    { name: '🚀 수집 후 바로 이력서 생성', value: 'both' }
  ];

  const mode = await select('원하는 작업을 선택하세요', menuChoices);

  console.log('');

  if (mode === 'collect') {
    await collectCommits();
  } else if (mode === 'generate') {
    await generateResume();
  } else if (mode === 'both') {
    const outputFile = await collectCommits();
    if (outputFile) {
      console.log(`${COLORS.dim}이력서 생성을 시작합니다...${COLORS.reset}\n`);
      await generateResume(outputFile);
    }
  }

  process.exit(0);
}

main().catch((error) => {
  showCursor();
  console.error(`\n${COLORS.red}오류 발생:${COLORS.reset}`, error.message);
  process.exit(1);
});
