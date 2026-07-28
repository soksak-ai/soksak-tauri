// 자식 프로세스에 넣을 시크릿 — **해소하는 자리는 계약이다.**
//
// 스트림 출구(StreamSink)·활동 원장(ActivitySink)·봉인 열쇠(SealKeys)와 같은 이유다. 지금 이
// 자리는 `State<SecretsState>` 이고, 그 한 줄 때문에 "자식을 띄운다"는 일 전체가 볼트를 가진
// 프로세스에 묶인다 — 시크릿이 **필요할 때만** 볼트가 필요한데도.
//
// 계약은 한 줄이다: 이 ns 의 이 키를 평문으로. 평문은 이 경계를 지나 곧바로 자식의 env 로만
// 간다 — 호출자가 그것을 값으로 돌려주면 그 순간 JS 로 샌다.

use std::collections::HashMap;

/// 시크릿 해소자. 구현은 볼트를 가진 쪽이 준다.
pub trait SecretSource: Send + Sync {
    /// 이 ns 의 이 키를 평문으로. 잠겼거나 없으면 사유를 달고 실패한다.
    fn resolve(&self, ns: &str, key: &str) -> Result<String, String>;
}

/// 볼트가 없는 호스트 — 시크릿을 다루지 않는다고 **선언**한다.
///
/// 조용한 빈 값이 아니다: 빈 값을 주면 자식이 빈 토큰으로 붙어 인증 실패를 "설정이 틀렸다"로
/// 보고하고, 진짜 사유(이 프로세스에 볼트가 없다)는 어디에도 안 남는다.
pub struct NoSecrets;

impl SecretSource for NoSecrets {
    fn resolve(&self, ns: &str, key: &str) -> Result<String, String> {
        Err(format!(
            "이 프로세스에는 볼트가 없습니다 — {ns}/{key} 를 해소할 수 없습니다"
        ))
    }
}

/// `secret_env`(envVar→secretKey)를 평문 쌍으로 해소한다.
///
/// 비어 있으면 빈 벡터다 — 볼트를 부르지 않는다. 시크릿이 필요 없는 spawn 이 볼트 유무로
/// 갈리면, 볼트 없는 프로세스는 아무것도 못 띄운다.
///
/// 비어 있지 않으면 ns 가 필수이고, **하나라도 실패하면 전부 실패한다.** 일부만 넣으면 자식이
/// 반쯤 설정된 채로 떠서 그 실패가 시크릿 문제로 보이지 않는다.
pub fn resolve_secret_env(
    source: &dyn SecretSource,
    ns: Option<&str>,
    secret_env: &Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    match secret_env {
        Some(map) if !map.is_empty() => {
            let ns = ns.ok_or("secret_env 주입에는 ns 필수")?;
            // 정렬은 결정성을 위해서다 — 실패 사유가 호출마다 다른 키를 가리키면 진단이 흔들린다.
            let mut keys: Vec<(&String, &String)> = map.iter().collect();
            keys.sort();
            let mut out = Vec::with_capacity(keys.len());
            for (env_var, secret_key) in keys {
                out.push((env_var.clone(), source.resolve(ns, secret_key)?));
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Vault {
        asked: Mutex<Vec<(String, String)>>,
        missing: bool,
    }

    impl SecretSource for Vault {
        fn resolve(&self, ns: &str, key: &str) -> Result<String, String> {
            self.asked
                .lock()
                .unwrap()
                .push((ns.to_string(), key.to_string()));
            if self.missing {
                return Err(format!("없음: {key}"));
            }
            Ok(format!("plain-{key}"))
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
        Some(
            pairs
                .iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
        )
    }

    /// 시크릿이 없으면 볼트를 부르지 않는다 — 부르면 볼트 없는 프로세스가 아무것도 못 띄운다.
    #[test]
    fn a_spawn_without_secrets_never_asks_the_vault() {
        let v = Vault::default();
        assert!(resolve_secret_env(&v, None, &None).unwrap().is_empty());
        assert!(resolve_secret_env(&v, None, &env(&[])).unwrap().is_empty());
        assert!(v.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn every_named_secret_is_resolved_in_order() {
        let v = Vault::default();
        let got = resolve_secret_env(&v, Some("plug"), &env(&[("B", "k2"), ("A", "k1")])).unwrap();
        // 정렬은 결정성을 위해서다 — 실패가 가리키는 키가 호출마다 바뀌면 진단이 흔들린다.
        assert_eq!(
            got,
            vec![
                ("A".to_string(), "plain-k1".to_string()),
                ("B".to_string(), "plain-k2".to_string())
            ]
        );
    }

    /// 하나라도 실패하면 전부 실패한다 — 반쯤 설정된 자식은 그 실패가 시크릿 문제로 안 보인다.
    #[test]
    fn one_missing_secret_fails_the_whole_spawn() {
        let v = Vault { missing: true, ..Default::default() };
        let e = resolve_secret_env(&v, Some("plug"), &env(&[("A", "k1")])).unwrap_err();
        assert!(e.contains("k1"), "{e}");
    }

    #[test]
    fn secrets_without_a_namespace_are_refused() {
        let v = Vault::default();
        let e = resolve_secret_env(&v, None, &env(&[("A", "k1")])).unwrap_err();
        assert!(e.contains("ns"), "{e}");
    }

    /// 볼트 없는 호스트는 **선언한다**. 빈 값을 주면 자식이 빈 토큰으로 붙고, 그 인증 실패는
    /// "설정이 틀렸다"로 보고되어 진짜 사유가 사라진다.
    #[test]
    fn a_host_without_a_vault_says_so() {
        let e = resolve_secret_env(&NoSecrets, Some("plug"), &env(&[("A", "k1")])).unwrap_err();
        assert!(e.contains("볼트"), "{e}");
        assert!(e.contains("plug/k1"), "무엇을 못 했는지 말해야 한다: {e}");
        // 시크릿이 없으면 볼트 없는 호스트도 그대로 통과한다.
        assert!(resolve_secret_env(&NoSecrets, None, &None).unwrap().is_empty());
    }
}
