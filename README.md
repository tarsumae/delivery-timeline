# 배달 타임라인

배달 한 사람의 하루 동선을 네이버 지도에 보는 정적 사이트입니다. 위치는 저장소에 AES-GCM으로 암호화되어 있고, 비밀번호를 아는 브라우저에서만 풀립니다.

공개 주소: https://tarsumae.github.io/delivery-timeline/

지금 들어 있는 `data/timeline.enc.json`은 가짜 샘플입니다. 비밀번호는 `sample` 입니다.

## 1. `config.js`에 Client ID 넣기

`config.example.js`와 같은 형식입니다.

```js
window.NAVER_CLIENT_ID = "발급받은 Client ID";
```

지도 스크립트는 현재 파라미터인 `ncpKeyId`를 사용합니다.

```html
https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=CLIENT_ID
```

예전 콘솔의 `ncpClientId`는 쓰지 않습니다. Client ID는 웹 서비스 URL로 제한되는 공개 값이라 이 파일에 넣고 커밋합니다. **Client Secret은 코드, 설정, 커밋 어디에도 넣지 마세요.**

## 2. NCP 콘솔에 Web 서비스 URL 등록

[네이버 클라우드 플랫폼 콘솔](https://console.ncloud.com/) → **Services → Application Services → Maps → Application**.

- API에서 **Dynamic Map**을 선택합니다.
- Web 서비스 URL에 `https://tarsumae.github.io` 를 등록합니다. 경로와 포트는 빼야 합니다. `https://tarsumae.github.io/delivery-timeline` 처럼 경로를 붙이면 인증이 실패합니다.
- 로컬에서 지도를 보려면 `http://localhost` 도 같은 칸에 추가합니다. 이쪽도 포트는 빼야 합니다.

## 3. 기록을 암호화해서 커밋

평문 JSON은 저장소에 올리지 않습니다. 비밀번호는 환경 변수로만 넘깁니다.

```bash
python3 -m pip install -r requirements.txt
TIMELINE_PASSWORD='원하는 비밀번호' python3 tools/encrypt.py plain.json
git add data/timeline.enc.json
```

`tools/encrypt.py`는 평문 경로만 argv로 받고, 비밀번호는 `TIMELINE_PASSWORD`에서 읽습니다. 비밀번호를 argv로 넘기면 무시하고, 출력에도 찍지 않습니다. 결과 파일은 항상 `data/timeline.enc.json` 입니다.

샘플을 다시 만들 때:

```bash
TIMELINE_PASSWORD=sample python3 tools/encrypt.py test/fixtures/sample.plain.json
```

`test/fixtures/sample.plain.json`은 도로명과 단지명이 모두 가짜입니다. 실제 동선 파일은 커밋하지 마세요.

## 화면

- 날짜는 기록이 있는 날만 고를 수 있고, 처음에는 가장 최근 날이 열립니다.
- 주간(저녁)은 주황 `#E86A17`, 야간(새벽)은 파랑 `#1D4ED8` 원입니다. 각 근무를 켜고 끌 수 있습니다.
- 지도는 그 날의 점에 맞춰 잡힙니다. **경로 보기**는 꺼져 있고, 켜면 해당 근무의 `path`만 선으로 그립니다.
- 원을 누르면 정보창에 도로명(크게), 지번(작게), 주간/야간 배지만 나옵니다. 시간은 지도에 나오지 않습니다. 도로명이 비어 있으면 지번을 크게 보여 줍니다.
- 지도 아래 목록은 시간순이고 근무별로 묶입니다. 줄을 누르면 그 점을 줌 17로 옮기고 같은 정보창을 엽니다.
- **전체 기간**은 모든 날짜의 원과 주소 목록입니다. 단지명(`name`)이 같거나 도로명이 같으면 한 줄로 합칩니다. 빈 이름과 빈 도로명은 서로 붙지 않습니다.
- **이 기기에 기억**을 켜면 이 브라우저에 비밀번호가 남습니다. **잠금**은 화면의 기록과 기억된 비밀번호를 지웁니다.
- 기본 지도는 배경과 한글 라벨만 요청합니다(`overlayType: bg.lko`). 시설·역 같은 세부 POI 레이어는 빼 둡니다.
- Client ID가 아직 placeholder이면 점 위치만 상대 좌표로 보여 주고, ID를 넣은 뒤 네이버 지도로 바뀝니다.

Galaxy Z Fold5 커버(가로 344px)는 지도 아래 목록, 안쪽 화면(가로 690px)은 지도와 목록을 나란히 둡니다.

## 평문 형식

```json
{
  "days": [
    {
      "date": "2026-11-27",
      "shifts": [
        {
          "kind": "야간",
          "label": "야간 (새벽)",
          "stops": [
            {
              "t": "03:12",
              "lat": 37.26,
              "lon": 127.05,
              "road": "도로명주소 or empty",
              "jibun": "지번주소",
              "name": "optional 단지명"
            }
          ],
          "path": [[37.26, 127.05]]
        }
      ]
    }
  ]
}
```

- `kind`는 `야간` 또는 `주간`입니다.
- `label`은 `야간 (새벽)` 또는 `주간 (저녁)`이고, `kind`와 짝이 맞아야 합니다.
- `road`는 빈 문자열일 수 있습니다. `name`은 없어도 됩니다.
- `path`는 선택입니다. 있으면 `[lat, lon]` 점이 두 개 이상이어야 합니다.

## 암호문 형식

`data/timeline.enc.json`:

```json
{
  "v": 1,
  "kdf": "PBKDF2-SHA256",
  "iter": 210000,
  "salt": "<base64, 16바이트>",
  "iv": "<base64, 12바이트>",
  "ct": "<base64, AES-GCM 암호문과 16바이트 태그>"
}
```

키는 비밀번호 UTF-8을 PBKDF2-SHA256으로 210,000번 돌려 만든 32바이트입니다. AES-256-GCM이고 추가 인증 데이터는 없습니다. 브라우저의 `js/crypto.js`가 이 파일을 WebCrypto로 풉니다. 반복 횟수는 200,000 이상이어야 합니다.

## 테스트

```bash
python3 -m pip install -r requirements.txt
node --test
```

테스트는 Python으로 암호화한 뒤, 페이지와 같은 `js/crypto.js`를 Node WebCrypto로 풀어 평문과 비교합니다. 끝난 뒤 저장소의 샘플 암호문을 원래 바이트로 되돌립니다.

## GitHub Pages

워크플로는 `.github/workflows/pages.yml` 입니다. `main`에 푸시되면 사이트 파일만 올려서, 평문 픽스처와 `tools/`는 페이지에 포함되지 않습니다.

Pages가 꺼져 있으면 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 바꿉니다. `main`에 워크플로가 있는 상태로 푸시하면 https://tarsumae.github.io/delivery-timeline/ 에 배포됩니다.
