# 토론함뜰래? (Wanna Debate?)

AI가 토론 주제를 던지고 심판을 보는 2인 실시간 토론 웹게임입니다.

- 로비에 주제가 정해진 공개 토론회가 늘 열려 있어서, 재밌어 보이는 방에 바로 들어가거나 랜덤 매칭으로 상대를 찾습니다. 친구와는 비공개방(초대 코드)으로 붙습니다.
- 두 플레이어가 각자 찬성/반대를 고르고, 같은 쪽을 고르면 코인토스로 나눕니다.
- 입론(턴제, 90초) → 자유토론(3분, 채팅처럼) → 최종 변론(턴제, 60초, 입론과 반대 순서)
- 발언마다 AI가 우세 게이지(예: 찬성 58 : 42 반대)를 갱신합니다.
- 끝나면 최종 점수, 승리 이유, 양측 핵심 논지, 토론 팁을 담은 리포트가 나옵니다.

기획서: [docs/기획서.md](docs/기획서.md)

## 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
cp .env.example .env   # 그다음 .env에 GEMINI_API_KEY 입력
npm start              # http://localhost:3000
```

- API 키는 [Google AI Studio](https://aistudio.google.com/apikey)에서 발급받습니다.
- `.env`는 `.gitignore`에 들어 있어 커밋되지 않습니다. 키는 서버에서만 쓰이고 브라우저로 보내지지 않습니다.
- `GEMINI_API_KEY`를 비워 두면 가짜 AI 응답을 쓰는 테스트 모드로 실행됩니다.
- 혼자 테스트할 때는 같은 브라우저에서 탭 두 개를 열면 됩니다. 한 탭에서 방을 만들고, 새 탭에 초대 링크를 붙여 넣으세요. (탭 복제 기능은 같은 플레이어로 인식되니 쓰지 마세요.)

## 배포 (Render)

저장소에 [render.yaml](render.yaml)이 있어서 Render Blueprint로 바로 배포할 수 있습니다.

1. [Render](https://render.com)에 GitHub 계정으로 가입
2. 대시보드에서 **New → Blueprint** → 이 저장소 선택
3. `GEMINI_API_KEY` 값을 입력하고 **Apply**
4. 배포가 끝나면 `https://<서비스 이름>.onrender.com` 주소로 누구나 접속

- 무료 플랜은 15분간 접속이 없으면 잠들고, 다음 접속 때 깨어나는 데 수십 초 걸립니다. 잠들거나 다시 배포되면 진행 중인 방은 사라집니다.
- 방과 닉네임을 서버 메모리에 두므로 인스턴스는 1대로 유지해야 합니다.
- `main`에 푸시하면 자동으로 다시 배포됩니다.

## 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | (없음) | Gemini API 키 |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | 주제 생성, 게이지 채점 모델 (빠른 모델) |
| `GEMINI_REPORT_MODEL` | `gemini-flash-latest` | 최종 리포트 모델. 실패하면 `GEMINI_MODEL`로 대체 |
| `PORT` | `3000` | 서버 포트 |
| `OPENING_SECONDS` | `90` | 입론 한 턴 제한 시간(초) |
| `FREE_SECONDS` | `180` | 자유토론 시간(초) |
| `CLOSING_SECONDS` | `60` | 최종 변론 한 턴 제한 시간(초) |
| `OPEN_ROOMS` | `6` | 로비에 늘 열어 두는 공개 토론회 수 |
| `NAME_GRACE_SECONDS` | `15` | 창을 닫은 뒤 닉네임을 풀어 주기까지 기다리는 시간(초) |
| `MAX_ROOMS` | `200` | 동시에 열 수 있는 방 수 |
| `CREATE_LIMIT` | `5` | IP당 10분에 만들 수 있는 비공개방 수 |
| `TRUST_PROXY` | (꺼짐) | 리버스 프록시 뒤에서 실제 IP를 쓰려면 `1` |

## 구조

```
server.js        방 관리, 턴 진행, 타이머 (Express + Socket.IO)
src/ai.js        Gemini 호출: 주제 생성, 게이지 채점, 최종 리포트
src/topics.js    주제 풀: 서버가 분야·키워드를 뽑고 AI가 8개씩 미리 만들어 둠
public/          화면 (HTML/CSS/JS), music.js: 진행 단계별 배경음악
public/audio/    배경음악 (lobby 로비, intro 입론, free 자유토론, final 최종 변론·판정 대기, end 판정 공개)
docs/기획서.md    기획서
```
