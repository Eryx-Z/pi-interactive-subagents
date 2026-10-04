import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { TaskManager } from "./tasks.ts";
import type { TaskRecord } from "./store.ts";

export type TaskAction = "Message" | "Answer question" | "Cancel" | "Continue";
export interface DashboardAction { id: string; action: TaskAction }
export interface DashboardState {
  selectedId?: string;
  detailFocus: boolean;
  views: Map<string, { top: number; follow: boolean }>;
}
export const dashboardState = (): DashboardState => ({ detailFocus: false, views: new Map() });
type Content = { summary: (record: TaskRecord) => string; detail: (record: TaskRecord) => string };

// Stable within each attention group: streaming updates must not reorder peers.
export function dashboardRecords(records: Iterable<TaskRecord>): TaskRecord[] {
  const priority = (r: TaskRecord) => r.questions.some(q => !q.responseSent) ? 0
    : r.state === "failed" || (!r.stopped && r.state !== "running" && r.state !== "waiting") ? 1
    : r.state === "running" || r.state === "waiting" ? 2 : 3;
  return [...records].sort((a, b) => priority(a) - priority(b));
}

export class TaskDashboard {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private completed = false;
  private scroll = new ScrollView({ render: () => [], invalidate() {} }, { follow: "end", scrollbar: "hidden" });
  private viewport = 1;
  constructor(
    private manager: Pick<TaskManager, "records">,
    readonly state: DashboardState,
    private tui: Pick<TUI, "requestRender" | "terminal">,
    private theme: Theme,
    private keys: Pick<KeybindingsManager, "matches">,
    private done: (action: DashboardAction | undefined) => void,
    private content: Content,
  ) {
    this.timer = setInterval(() => { if (!this.disposed) this.tui.requestRender(); }, 500);
    this.timer.unref();
  }
  private records(): TaskRecord[] {
    const records = dashboardRecords(this.manager.records.values());
    if (!records.some(r => r.id === this.state.selectedId)) this.state.selectedId = records[0]?.id;
    return records;
  }
  private view() {
    const id = this.state.selectedId;
    if (!id) return undefined;
    let view = this.state.views.get(id);
    if (!view) { view = { top: 0, follow: true }; this.state.views.set(id, view); }
    return view;
  }
  private finish(action?: DashboardAction): void {
    if (this.completed) return;
    this.completed = true;
    this.dispose();
    this.done(action);
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const selectedBefore = this.state.selectedId;
    const records = this.records();
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) { this.finish(); return; }
    if (this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "tab")) {
      this.state.detailFocus = !this.state.detailFocus;
    } else {
      const action: TaskAction | undefined = data === "m" ? "Message" : data === "a" ? "Answer question"
        : data === "c" ? "Continue" : data === "x" ? "Cancel" : undefined;
      // If a record disappeared between render and input, route its original ID so
      // the native action reports an error rather than acting on an unseen fallback.
      const actionId = selectedBefore ?? this.state.selectedId;
      if (action && actionId) { this.finish({ id: actionId, action }); return; }
      const up = this.keys.matches(data, "tui.select.up"), down = this.keys.matches(data, "tui.select.down");
      const pageUp = this.keys.matches(data, "tui.select.pageUp"), pageDown = this.keys.matches(data, "tui.select.pageDown");
      const view = this.view();
      if (view && (pageUp || pageDown || matchesKey(data, "home") || matchesKey(data, "end") || (this.state.detailFocus && (up || down)))) {
        if (matchesKey(data, "end")) { view.follow = true; this.scroll.scrollToEnd(); }
        else {
          view.follow = false;
          const top = matchesKey(data, "home") ? 0 : this.scroll.scrollTop + (pageUp ? -this.viewport : pageDown ? this.viewport : up ? -1 : 1);
          this.scroll.scrollTo(top, { disableFollow: true });
        }
        view.top = this.scroll.scrollTop;
      } else if (!this.state.detailFocus && (up || down) && records.length) {
        const index = records.findIndex(r => r.id === this.state.selectedId);
        this.state.selectedId = records[Math.max(0, Math.min(records.length - 1, index + (up ? -1 : 1)))]!.id;
      }
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(1, Math.min(32, this.tui.terminal.rows - 2));
    const records = this.records(), record = records.find(r => r.id === this.state.selectedId);
    const th = this.theme;
    const fit = (text: string, w = width) => truncateToWidth(text, w);
    const pad = (text: string, w: number) => { const s = fit(text, w); return s + " ".repeat(Math.max(0, w - visibleWidth(s))); };
    const help = wrapTextWithAnsi("Esc close · ↑↓ select/scroll · Enter/Tab focus · PgUp/PgDn scroll · Home top · End follow · m message · a answer · c continue · x cancel", width);
    const footer = help.slice(0, Math.max(1, Math.min(help.length, Math.floor(height / 3))));
    // At extreme widths/heights keep navigation usable, even if the terminal cannot show all hints.
    const room = Math.max(0, height - footer.length - 2);
    const wide = width >= 90;
    const listWidth = wide ? Math.min(44, Math.floor(width * 0.38)) : width;
    const listHeight = wide ? room : Math.min(Math.max(1, Math.floor(room / 3)), 5);
    const detailWidth = wide ? Math.max(1, width - listWidth - 3) : width;
    const detailHeight = Math.max(0, wide ? room : room - listHeight - 1);
    const list = new SelectList(records.map(r => ({ value: r.id, label: this.content.summary(r) })), Math.max(1, listHeight), {
      selectedPrefix: s => th.fg("accent", s), selectedText: s => th.fg("accent", s),
      description: s => th.fg("muted", s), scrollInfo: s => th.fg("muted", s), noMatch: s => th.fg("muted", s),
    });
    list.setSelectedIndex(Math.max(0, records.findIndex(r => r.id === this.state.selectedId)));
    const left = records.length ? list.render(listWidth).slice(0, listHeight) : ["No subagent tasks yet"];
    const lines = wrapTextWithAnsi(record ? this.content.detail(record) : "Task record unavailable", detailWidth);
    this.viewport = Math.max(1, detailHeight);
    const view = this.view();
    // Suppress ScrollView's automatic resume-at-bottom: only End restores follow after manual scrolling.
    this.scroll.scrollTo(view?.top ?? 0, { disableFollow: !view?.follow });
    this.scroll.updateLayout(lines.length, this.viewport, () => {});
    if (view?.follow) this.scroll.scrollToEnd();
    else this.scroll.scrollTo(view?.top ?? 0, { disableFollow: true });
    if (view) view.top = this.scroll.scrollTop;
    const right = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + detailHeight);
    const body = wide ? Array.from({ length: room }, (_, i) => pad(left[i] ?? "", listWidth) + th.fg("border", " │ ") + fit(right[i] ?? "", detailWidth))
      : [...left, th.fg("border", "─".repeat(width)), ...right];
    const position = `${this.scroll.scrollTop + 1}/${lines.length}`;
    return [
      th.fg("accent", fit(`Subagents live · ${records.length} tasks · ${this.state.detailFocus ? "DETAIL" : "TASKS"} focus`)),
      th.fg("muted", fit(`${view?.follow ? "Following latest" : "Follow paused · End to resume"} · ${position}`)),
      ...body.slice(0, room), ...footer.map(s => th.fg("muted", fit(s))),
    ].slice(0, height).map(s => fit(s));
  }
  invalidate(): void { this.scroll.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  close(): void { this.finish(); }
}

// Includes interactions temporarily outside the overlay in a native dialog.
const sessions = new Set<{ close: () => void }>();
export function closeDashboards(): void { for (const session of [...sessions]) session.close(); }
export async function taskDashboard(
  manager: TaskManager, ctx: ExtensionContext, content: Content,
  perform: (id: string, action: TaskAction) => Promise<void>,
): Promise<void> {
  const state = dashboardState();
  let closed = false, component: TaskDashboard | undefined;
  const session = { close() { closed = true; component?.close(); } };
  sessions.add(session);
  try {
    while (!closed) {
      let action: DashboardAction | undefined;
      try {
        action = await ctx.ui.custom<DashboardAction | undefined>((tui, theme, keys, done) => {
          component = new TaskDashboard(manager, state, tui, theme, keys, done, content);
          return component;
        }, { overlay: true, overlayOptions: { anchor: "center", width: "95%", margin: 1 } });
      } finally { component?.dispose(); component = undefined; }
      if (!action || closed) break;
      // Native editors/confirmation dialogs must never be nested inside a focused overlay.
      try { await perform(action.id, action.action); }
      catch (error) { ctx.ui.notify(`Subagent action failed: ${String(error)}`, "error"); }
    }
  } finally { session.close(); sessions.delete(session); }
}
