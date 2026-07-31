import { memo, useRef, useState } from "react";
import { execute } from "../commands/registry";
import { isComposingEnter } from "../lib/imeKeys";
import { Icon } from "../ui/icons/Icon";
import { ProgramMenu } from "./ProgramMenu";
import { useSessions, type Program, type Project } from "../state/sessions";
import { useCloseConfirm } from "../state/closeConfirm";
import { useProgramRegistry } from "../plugins/programRegistry";
import { useT } from "../i18n";

// 컨텐츠 탭 바(3단 구조의 가운데). 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드)을 전환.
// 1,2,3,… 자동 번호 + 이름변경(더블클릭) + 닫기 + `+` 메뉴(터미널 / 에이전트▸Claude·Codex /
// 브라우저 — 선택한 프로그램으로 새 컨텐츠).

// memo 경계(원칙 2): 다른 프로젝트의 store 쓰기에는 리렌더되지 않는다.
export const ContentTabs = memo(function ContentTabs({
  project,
  vertical = false,
}: {
  project: Project;
  vertical?: boolean;
}) {
  const t = useT();
  const requestCloseContent = useCloseConfirm((s) => s.requestCloseContent);
  const setActiveContent = useSessions((s) => s.setActiveContent);
  const renameContent = useSessions((s) => s.renameContent);
  const hasPrograms = useProgramRegistry((s) => s.order.length > 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const commit = (id: string, raw: string, fallback: string) => {
    renameContent(project.id, id, raw.trim() || fallback);
    setEditingId(null);
  };

  const toggleMenu = () => {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const r = addBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
  };

  // 명령을 통해 만든다 — store 를 직접 부르면 관측·정규화·게이트가 통째로 빠진다. 실측
  // (2026-07-31): 이 자리가 store 를 직접 불러서, 사용자가 + 로 만든 스페이스가 활동 원장에
  // 한 줄도 남지 않았다. 무엇이 일어났는지 밖에서 읽을 수 없으면 원인 추적은 추측이 된다.
  // CLI·AI 가 부르는 space.create 와 같은 경로여야 둘이 갈리지 않는다.
  const pick = (program: Program) => {
    void execute("space.create", { project: project.id, program }, {});
    setMenuPos(null);
  };

  return (
    <div className={`space-tabs${vertical ? " vertical" : ""}`}>
      {project.spaces.map((c, idx) => (
        <div
          key={c.id}
          className={`space-tab${c.id === project.activeSpaceId ? " active" : ""}${editingId === c.id ? " editing" : ""}`}
          data-node={`tab/space/${idx}`}
          onClick={() => setActiveContent(project.id, c.id)}
          onDoubleClick={() => setEditingId(c.id)}
          title={c.title}
        >
          {editingId === c.id ? (
            <input
              className="space-tab-rename"
              defaultValue={c.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commit(c.id, e.target.value, c.title)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (isComposingEnter(e)) return; // IME 조합 확정 Enter 는 커밋 아님
                if (e.key === "Enter")
                  commit(c.id, e.currentTarget.value, c.title);
                else if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="space-tab-title">{c.title}</span>
          )}
          {project.spaces.length > 1 && editingId !== c.id && (
            <button
              type="button"
              className="icon-btn icon-btn--mini space-tab-close"
              data-node={`tab/space/${idx}/close`}
              title={t("space.close")}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseContent(project.id, c.id);
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      {/* 등록 프로그램 0개면 + 자체가 없다(내장 없음 §2.6 — 빈 메뉴를 열 이유가 없음) */}
      {hasPrograms && (
        <button
          ref={addBtnRef}
          type="button"
          className="icon-btn space-tab-add"
          // 주소 — 기계가 이 버튼을 누를 수 있어야 이 경로가 검증된다(§R2: 테스트가 어려우면
          // 먼저 검증 가능한 표면을 만든다). 주소가 없던 동안 "+ 로 생성이 안 된다"를 밖에서
          // 재현할 방법이 없었다.
          data-node="tab/space/add"
          title={t("space.new")}
          onClick={toggleMenu}
        >
          <Icon name="add" />
        </button>
      )}
      {menuPos && (
        <ProgramMenu
          pos={menuPos}
          onPick={pick}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
});
