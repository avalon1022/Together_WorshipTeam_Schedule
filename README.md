# 주일 예배팀 스케줄 (Firebase)

봉사자가 카카오로 로그인해서 가능한 주일(1부·2부)과 특별 일정을 체크하면, 팀(방송팀·찬양팀)과 역할별로 자동 배정하는 웹앱입니다.

- **화면**: Firebase Hosting (`public/index.html`)
- **서버**: Cloud Functions 하나(`api`) — 카카오 로그인, 자동 배정, 관리자 기능, 구글 캘린더 연동
- **데이터**: Firestore (브라우저에서 직접 접근은 모두 막고, 서버를 통해서만 읽고 씁니다)
- **로그인**: 카카오 로그인만. 관리자도 카카오 계정으로 지정합니다 (PIN 없음)

---

## 처음 설치하기

Mac 기준입니다. 처음 한 번만 하면 되고, 1~2시간 정도 걸립니다.

### 0. 준비물
Firebase 도구는 **Node.js 24**에서 씁니다. (Node 26처럼 너무 새 버전은 아직 지원하지 않습니다.)
관리자 권한(sudo) 없이 버전을 맞추기 위해 **nvm**으로 설치하는 것을 권합니다.

1. 터미널에서 nvm을 설치합니다.
   ```bash
   touch ~/.zshrc
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
   ```
   "명령줄 개발자 도구를 설치하겠습니까?" 창이 뜨면 **설치**를 누르고, 끝난 뒤 위 명령을 다시 실행합니다.
2. **터미널을 완전히 닫았다가 다시 엽니다.** 그다음 Node 24를 설치합니다.
   ```bash
   nvm install 24
   nvm alias default 24
   node -v          # v24.x.x 가 나오면 성공
   ```
3. Firebase 도구를 설치하고 로그인합니다. (nvm으로 설치한 Node에서는 sudo가 필요 없습니다)
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
4. 이 저장소를 내려받습니다.
   ```bash
   git clone https://github.com/avalon1022/Together_WorshipTeam_Schedule.git
   cd Together_WorshipTeam_Schedule
   ```

### 1. Firebase 프로젝트 만들기
1. [Firebase 콘솔](https://console.firebase.google.com)에서 **프로젝트 추가**를 누릅니다. Google 애널리틱스는 꺼도 됩니다.
2. 왼쪽 아래 **요금제**를 **Blaze(종량제)**로 바꿉니다. Cloud Functions를 쓰려면 필요합니다.
   - 무료 사용량 안에서는 청구되지 않습니다. 교회 규모라면 보통 0원입니다.
   - 안심하려면 [Google Cloud 결제 → 예산 및 알림](https://console.cloud.google.com/billing/budgets)에서 예산 알림(예: 월 5,000원)을 걸어 두세요.
3. **빌드 → Firestore Database → 데이터베이스 만들기**
   - 위치: **asia-northeast3 (서울)**
   - **프로덕션 모드**로 시작합니다. (보안 규칙은 배포할 때 이 저장소의 `firestore.rules`로 덮어씁니다.)
4. 터미널에서 이 프로젝트를 연결합니다.
   ```bash
   firebase use --add
   ```
   방금 만든 프로젝트를 고르고, 별칭(alias)은 `default`로 입력합니다.

### 2. 카카오 앱 설정
[developers.kakao.com](https://developers.kakao.com)에서 앱을 만들고(이미 있으면 그 앱을 써도 됩니다):
1. **[앱] > [플랫폼 키] > [REST API 키]** 화면에서
   - **REST API 키**를 복사해 둡니다.
   - **클라이언트 시크릿** 코드를 복사해 둡니다. (기본으로 켜져 있습니다)
   - **카카오 로그인 리다이렉트 URI**에 다음 주소를 등록합니다. `프로젝트ID`는 Firebase 프로젝트 ID입니다.
     ```
     https://프로젝트ID.web.app/auth/kakao/callback
     ```
     자체 도메인을 쓰면 그 주소(`https://내도메인/auth/kakao/callback`)도 함께 등록합니다.
2. **[카카오 로그인] > [사용 설정]**을 **ON**으로 합니다.
3. (선택) **[카카오 로그인] > [동의항목]**에서 **닉네임**을 '선택 동의'로 설정하면, 처음 등록할 때 이름 칸이 미리 채워집니다.

### 3. 설정 파일 만들기
```bash
cd functions
npm install
cp .env.example .env
```
`functions/.env` 파일을 열어 값을 채웁니다.
```
KAKAO_REST_API_KEY=복사한 REST API 키
PUBLIC_URL=https://프로젝트ID.web.app
CALENDAR_ID=            ← 구글 캘린더는 8단계에서 연결합니다. 지금은 비워 두세요.
CALENDAR_ICAL_URL=
```

### 4. 비밀 값 등록
비밀 값은 파일에 적지 않고 Google Secret Manager에 저장합니다. 터미널에서 하나씩 입력합니다. 명령을 입력하면 값을 물어봅니다.
```bash
firebase functions:secrets:set SESSION_SECRET
firebase functions:secrets:set KAKAO_CLIENT_SECRET
firebase functions:secrets:set ADMIN_SETUP_CODE
```
| 이름 | 넣을 값 |
|---|---|
| `SESSION_SECRET` | 로그인 쿠키 서명용 긴 임의 문자열. `openssl rand -hex 32`를 실행해 나온 값을 붙여넣으세요. |
| `KAKAO_CLIENT_SECRET` | 2단계에서 복사한 카카오 클라이언트 시크릿 |
| `ADMIN_SETUP_CODE` | 첫 전체 관리자가 될 때 한 번 입력할 코드. 남이 추측하기 어려운 문자열로 정하세요. |

### 5. 배포
저장소 맨 위 폴더(`firebase.json`이 있는 곳)에서:
```bash
cd ..
firebase deploy
```
처음 배포할 때 필요한 Google Cloud 기능(Cloud Functions, Cloud Build, Artifact Registry, Secret Manager 등)을 켤지 물으면 **Y**를 누릅니다. 몇 분 걸립니다.

끝나면 `Hosting URL: https://프로젝트ID.web.app`이 나옵니다. 이 주소가 앱 주소입니다.

### 6. 첫 전체 관리자 되기
1. 앱 주소를 열고 **가능한 날짜 입력 → 카카오 로그인**을 합니다.
2. **관리** 탭에서 4단계에서 정한 **관리자 설정 코드**를 입력합니다.
3. 이제 이 계정이 전체 관리자입니다. 설정 코드는 전체 관리자가 생긴 뒤에는 더 이상 쓸 수 없습니다.

### 7. 다른 관리자 지정
- 지정할 사람이 먼저 앱에 **카카오로 한 번 로그인**해야 합니다.
- 전체 관리자가 **관리 탭 → 관리자 지정**에서 그 사람을 **팀 담당자**(팀 선택) 또는 **전체 관리자**로 바꾸고 저장합니다.
- 팀 담당자는 자기 팀의 역할, 봉사자 역할, 수동 배정, 확정, 특별 일정만 관리합니다. 봉사자 삭제와 관리자 지정은 전체 관리자만 할 수 있습니다.

### 8. 구글 캘린더 연결 (선택)
팀 스케줄을 확정하면 교회 캘린더에 일정이 자동으로 올라가게 합니다.
1. **Google Calendar API 켜기**: [Google Cloud 콘솔 → API 라이브러리 → Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)에서 Firebase 프로젝트를 고르고 **사용**을 누릅니다.
2. **서버 계정 이메일 확인**: [Cloud Run 콘솔](https://console.cloud.google.com/run)에서 `api` 서비스를 누르고 **보안**(Security) 탭의 서비스 계정 이메일을 복사합니다. 보통 `숫자-compute@developer.gserviceaccount.com` 형태입니다.
3. **캘린더 만들고 공유하기**: [구글 캘린더](https://calendar.google.com)에서 왼쪽 **다른 캘린더 + → 새 캘린더 만들기**로 "주일 예배팀 스케줄" 캘린더를 만듭니다. 그 캘린더의 **설정 및 공유 → 특정 사용자 또는 그룹과 공유 → 사용자 추가**에서 2번의 이메일을 넣고, 권한을 **일정 변경**으로 합니다.
4. 같은 설정 화면 아래 **캘린더 통합**에서 **캘린더 ID**를 복사해 `functions/.env`의 `CALENDAR_ID=`에 넣습니다.
5. 봉사자 구독 방법을 고릅니다.
   - **공개하지 않기 (권장)**: 캘린더 통합의 **iCal 형식의 비공개 주소**를 복사해 `CALENDAR_ICAL_URL=`에 넣습니다. 앱을 아는 사람만 이 주소로 구독할 수 있습니다.
   - **공개하기**: 액세스 권한에서 '공개 사용 설정'을 켭니다. 주소를 아는 인터넷의 누구나 볼 수 있게 됩니다.
6. 다시 배포합니다.
   ```bash
   firebase deploy --only functions
   ```

### 9. 자체 도메인 (선택)
Firebase 콘솔 **Hosting → 커스텀 도메인 추가**에서 도메인을 연결하고, DNS 설정을 안내대로 합니다. 연결이 끝나면:
- `functions/.env`의 `PUBLIC_URL`을 새 주소로 바꿉니다.
- 카카오 리다이렉트 URI에 `https://새도메인/auth/kakao/callback`을 추가합니다.
- `firebase deploy --only functions`로 다시 배포합니다.

### 10. 자동 배포 (GitHub Actions)
설정해 두면 `main` 브랜치에 코드가 올라올 때마다 시험을 돌리고, 통과하면 자동으로 배포합니다. (`.github/workflows/deploy.yml`)

**① 배포용 서비스 계정 만들기** — [Google Cloud 콘솔](https://console.cloud.google.com)에서 내 프로젝트 선택
1. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기**, 이름 `github-deploy`
2. **역할**에 아래 7개를 추가 (역할 검색창에 이름 입력)
   - Firebase 관리자 (Firebase Admin)
   - Cloud Functions 관리자 (Cloud Functions Admin)
   - Cloud Run 관리자 (Cloud Run Admin)
   - 서비스 계정 사용자 (Service Account User)
   - Secret Manager 관리자 (Secret Manager Admin)
   - Artifact Registry 관리자 (Artifact Registry Administrator)
   - 서비스 사용량 소비자 (Service Usage Consumer)
3. 만든 계정 클릭 → **키 → 키 추가 → 새 키 만들기 → JSON** → 파일이 내려받아집니다.

**② GitHub 저장소에 등록** — 저장소 **Settings → Secrets and variables → Actions**
- **Secrets** 탭 → New repository secret
  - `FIREBASE_SERVICE_ACCOUNT`: 내려받은 JSON 파일 내용 전체 (메모장으로 열어 통째로 복사)
  - `CALENDAR_ICAL_URL`: (선택) 캘린더 비공개 iCal 주소
- **Variables** 탭 → New repository variable
  - `FIREBASE_PROJECT_ID`: 프로젝트 ID
  - `KAKAO_REST_API_KEY`: 카카오 REST API 키
  - `PUBLIC_URL`: 앱 주소 (예: `https://프로젝트ID.web.app`)
  - `CALENDAR_ID`: (선택) 캘린더 ID

JSON 키 파일은 프로젝트를 배포할 수 있는 열쇠입니다. GitHub에 넣은 뒤 컴퓨터에서 지우고, 절대 저장소에 커밋하지 마세요.

**③ 확인** — 저장소 **Actions 탭 → 배포 → Run workflow**. 초록 체크가 뜨면 성공입니다.

자동 배포를 쓰면 GitHub의 Variables가 기준이 됩니다. 값을 바꿀 때는 Variables를 고친 뒤 Actions 탭에서 **Run workflow**를 누르세요. (`firebase functions:secrets:set`으로 넣은 비밀 값 세 개는 Firebase에 그대로 있으므로 GitHub에 넣지 않습니다.)

### 11. 홈 화면 앱과 관리자 푸시 알림
**홈 화면 앱(PWA)** 은 따로 설정할 것이 없습니다. 휴대폰으로 사이트를 열면 위쪽에 설치 안내가 나옵니다.
- 아이폰: Safari → 공유 버튼(□↑) → **홈 화면에 추가**
- 안드로이드: Chrome에서 **설치** 버튼 (또는 메뉴 → 홈 화면에 추가)
- 카카오톡 안에서 링크를 열었다면 먼저 ‘다른 브라우저로 열기’를 하세요.

**관리자 푸시 알림** 은 전체 관리자에게만 갑니다: 새 봉사자 가입·연결, 봉사자 일정 저장(같은 사람은 10분에 한 번), 다른 관리자의 확정·해제, 매달 20일 오전 10시 다음 달 미입력자(`functions/config.js`의 `REMIND`).

처음 한 번만 설정합니다.
1. 알림용 개인 키를 만들어 비밀 값으로 등록합니다. (첫 줄이 출력한 값을 둘째 줄에 붙여넣기)
   ```bash
   node -e "const c=require('crypto').createECDH('prime256v1');c.generateKeys();console.log(c.getPrivateKey('base64url'))"
   firebase functions:secrets:set VAPID_PRIVATE_KEY
   ```
   이 키를 바꾸면 모든 기기에서 알림을 다시 켜야 합니다.
2. [Google Cloud 콘솔](https://console.cloud.google.com) → **API 및 서비스 → 라이브러리** → **Cloud Scheduler API** 사용 (미입력자 알림용)
3. **IAM 및 관리자 → IAM** → `github-deploy` 계정 연필 아이콘 → 역할 **Cloud Scheduler 관리자 (Cloud Scheduler Admin)** 추가
4. 다시 배포한 뒤, 전체 관리자가 휴대폰에서 **관리 탭 → 푸시 알림 → 이 기기에서 알림 받기** → **시험 알림 보내기**

아이폰은 iOS 16.4 이상에서, **홈 화면에 추가한 앱으로 열었을 때만** 알림을 켤 수 있습니다.

---

## 바꾸고 싶을 때
| 바꿀 것 | 위치 |
|---|---|
| 팀 이름, 1·2부를 둘 다 섬길 수 있는 팀 | `functions/config.js`의 `CATEGORIES` |
| 이미 쓰던 팀 이름 바꾸기 | `CATEGORIES`의 이름을 바꾸고 `RENAMED_CATEGORIES`에 `{ '예전 이름': '새 이름' }` 추가 → 저장된 데이터가 자동으로 옮겨짐 |
| 주일 예배 시간 (캘린더 시간) | `functions/config.js`의 `SERVICE_TIMES` |
| 로그인 유지 기간 | `functions/config.js`의 `SESSION_DAYS` |
| 역할과 필요 인원 | 앱의 **관리 탭** (배포 필요 없음) |
| 화면 | `public/index.html` |

코드를 바꾼 뒤에는 `firebase deploy`로 다시 배포합니다. 화면만 바꿨다면 `firebase deploy --only hosting`으로 충분합니다. 10단계 자동 배포를 설정했다면 `main`에 올리기만 하면 됩니다.

## 로컬 미리보기와 시험
설치 없이 내 컴퓨터에서 화면을 확인할 수 있습니다. 데이터는 메모리에만 저장되고, 카카오 로그인은 가짜 화면으로 대신합니다.
```bash
node test/devserver.js      # http://localhost:5050 (관리자 설정 코드: SETUP-123)
node test/run.js            # 서버 시험
```

## 문제 해결
| 증상 | 원인과 해결 |
|---|---|
| `npm install -g` 때 `EACCES: permission denied` | 시스템에 설치된 Node를 쓰고 있습니다. 0단계대로 nvm으로 Node 24를 설치한 뒤 다시 실행하세요. |
| `EBADENGINE … current: { node: 'v26…' }` | Node가 너무 새 버전입니다. `nvm use 24`(또는 0단계) 후 다시 실행하세요. |
| 배포 때 `Blaze plan` 관련 오류 | 1-2단계의 Blaze 요금제 전환을 하지 않았습니다. |
| 배포 때 secret 관련 오류 | 4단계의 비밀 값 세 개를 모두 등록해야 합니다. |
| "카카오 로그인 설정이 필요해요" | `functions/.env`의 `KAKAO_REST_API_KEY`가 비어 있습니다. 넣고 다시 배포하세요. |
| KOE006 / "Redirect URI가 카카오 앱 설정과 달라요" | 카카오에 등록한 주소가 `PUBLIC_URL + /auth/kakao/callback`과 정확히 같은지 확인하세요. |
| KOE010 / "Client Secret 설정이 맞지 않아요" | `KAKAO_CLIENT_SECRET` 값을 다시 등록하고 `firebase deploy --only functions` 하세요. |
| "구글 캘린더에 반영하지 못했어요 … 403/404" | Calendar API를 켰는지, 캘린더를 서버 계정 이메일에 **일정 변경** 권한으로 공유했는지, `CALENDAR_ID`가 맞는지 확인하세요. |
| 관리 탭에 "관리자 권한이 없어요" | 전체 관리자가 **관리자 지정**에서 권한을 줘야 합니다. |

## 보안 메모
- Firestore 규칙은 브라우저의 직접 접근을 모두 막습니다. 모든 데이터는 서버를 거칩니다.
- 로그인은 서명된 `__session` 쿠키(HttpOnly, Secure, SameSite=Lax)로 유지됩니다. 카카오 토큰은 저장하지 않고 회원번호만 씁니다.
- 일반 봉사자 화면에는 다른 사람의 가능한 날짜가 전달되지 않습니다.
- 모든 사람을 한 번에 로그아웃시키려면 `SESSION_SECRET`을 새 값으로 다시 등록하고 배포하세요.

## 폴더 구조
```
public/index.html        화면
functions/index.js       Cloud Functions 진입점 (비밀 값·설정 연결)
functions/config.js      교회별 설정
functions/src/logic.js   자동 배정과 화면 데이터 (순수 로직)
functions/src/service.js 요청 처리 (본인·관리자 작업, 캘린더 반영)
functions/src/store.js   Firestore 저장 (캐시로 읽기 횟수 절약)
functions/src/auth.js    카카오 로그인과 세션
functions/src/calendar.js 구글 캘린더
functions/src/http.js    주소별 처리
firestore.rules          Firestore 보안 규칙 (전부 차단)
test/                    시험과 로컬 미리보기
```
