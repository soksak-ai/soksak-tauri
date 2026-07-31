import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 브라우저 즐겨찾기(전역) — app.data 권위 + ls 동기캐시(coreSync), 멀티창 일관.

export interface Bookmark {
  url: string;
  title: string;
}

interface BookmarksState {
  list: Bookmark[];
  has: (url: string) => boolean;
  toggle: (url: string, title: string) => void;
  remove: (url: string) => void;
}

const KEY = "soksak.bookmarks";

const bookmarksSync = createCoreSync<Bookmark[]>({
  key: "bookmarks",
  lsKey: KEY,
  fallback: [],
  apply: (list) => useBookmarks.setState({ list: Array.isArray(list) ? list : [] }),
});
export const initBookmarksPersistence = (deps: CoreStoreDeps): (() => void) =>
  bookmarksSync.init(deps);

function load(): Bookmark[] {
  const v = bookmarksSync.loadSync();
  return Array.isArray(v) ? v : [];
}

// store 는 모듈 경계 밖에 산다 — 갈아끼우기가 이것을 갈면 등록·구독·화면 상태가 통째로
// 새것이 되고, 채우던 쪽은 이미 채웠다고 알아 다시 채우지 않는다(영영 빈 채).
export const useBookmarks = moduleState("state/bookmarks#store", () =>
  create<BookmarksState>((set, get) => {
  const save = (list: Bookmark[]) => {
    bookmarksSync.save(list);
    set({ list });
  };
  return {
    list: load(),
    has: (url) => get().list.some((b) => b.url === url),
    toggle: (url, title) => {
      const list = get().list;
      if (list.some((b) => b.url === url)) {
        save(list.filter((b) => b.url !== url));
      } else {
        save([...list, { url, title }]);
      }
    },
    remove: (url) => save(get().list.filter((b) => b.url !== url)),
  };
}),
);
