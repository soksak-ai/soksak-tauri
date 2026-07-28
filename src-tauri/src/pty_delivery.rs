// 전달 단위는 코어가 소유한다(soksak_core::pty_delivery) — 앱과 헬퍼가 같은 배치 규칙을 쓴다.
//
// 크로싱 비용은 어느 프레임워크에서나 같은 문제다. 규칙이 두 벌이면 같은 출력이 프로세스마다
// 다른 횟수로 건너가고, 그 차이는 오류가 아니라 "이쪽이 느리다"로만 나타난다.

pub(crate) use soksak_core::pty_delivery::spawn_delivery;
