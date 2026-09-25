# 저장소에 보관하는 외부 도트

에셋 빌드가 다른 사람의 GitHub 저장소에서 받아 쓰는 도트 중, **원본이 사라지거나 바뀌면 게임에서 그림이
빠지는 것**을 여기에 복사해 둡니다. 빌드는 이 폴더를 먼저 읽고, 원본에는 접속하지 않습니다.

| 폴더 | 원본 | 고정한 커밋 | 쓰는 곳 |
| --- | --- | --- | --- |
| `essentials/` | Pokémon Essentials Gen 8/9 리소스 팩 (Manurocker95/Pokemon-Essentials-21-With-Unofficial-EBDX에 담긴 사본) | `ebf87d8d` | Sprite Collab에 없는 55종·8개 폼·암컷 2종의 걷기 도트(평범·이로치), 크레딧 파일 |
| `smogon/` | Smogon Sprite Project (smogon/sprites) | `bad55c7b` | 전투에서만 나오는 3개 폼(윽우지 두 모습, 가라르 달마모드)의 DS 스타일 도트(평범·이로치) |

파일은 원본 저장소에서의 경로 그대로 들어 있습니다.

## `index.json`

- `present` — 받아서 여기 보관한 파일
- `absent` — 원본에 물어봤지만 없던 파일(대부분 `_female` 시트가 없는 종). 네트워크 없이도 "없음"으로 답합니다.
- `commit` / `base` — 목록에 없는 파일이 새로 필요해질 때 받아 올 곳. 브랜치가 아니라 커밋으로 고정되어 있어,
  원본 저장소가 나중에 파일을 바꾸거나 지워도 같은 그림을 받습니다.

새로 필요한 파일이 생기면(예: Collab이 어떤 종의 그림을 빼서 Essentials로 대체해야 할 때) 빌드가 원본에서
받아 이 폴더와 `index.json` 에 추가하고, 로그에 `vendored …: N path(s) new to data/vendor/… — commit them`
을 남깁니다. 그 파일들을 커밋하면 됩니다. 원본에 접속할 수 없으면 아무것도 기록하지 않고, 다음 빌드에서 다시 묻습니다.

어떤 종의 걷기 도트든 빠지면 에셋 검증(`npm run assets -- --only verify`)이 실패합니다 — 출처가 사라져
박스 아이콘으로 조용히 넘어가는 일이 없도록.

## 라이선스와 크레딧

모두 팬 작품이며, 비상업 팬 프로젝트에서 출처를 밝히는 조건으로 공개되어 있습니다. 게임의 **설정 → 크레딧**
탭이 Essentials 오버월드 작가 목록(`essentials/gen9_credits.txt` 에서 읽음)과 Smogon Sprite Project를
보여 줍니다. 포켓몬의 권리는 Nintendo / Creatures Inc. / GAME FREAK inc. 에 있습니다.
