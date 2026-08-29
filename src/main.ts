import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  acceptsExtension,
  conversionIssue,
  conversionTargets,
  extensionLabel,
  formatBytes,
  outputChoices,
  type TaskFunction,
} from "./task-options.ts";
import {
  allowedImportExtensions,
  clearIsEnabled,
  duplicateNotice,
  importIsReady,
  partitionImportCandidates,
  removeSelectedIsEnabled,
  validImportDetails,
  type RotatePageMode,
} from "./import-rules.ts";
import {
  selectEveryQueuePath,
  selectQueueArrow,
  selectQueueIndex,
} from "./queue-selection.ts";

type FileEntry = {
  path: string;
  name: string;
  bytes: number;
  extension: string;
};

type CollectedFiles = {
  files: FileEntry[];
  ignored: number;
  truncated: boolean;
  folderDepthLimited: boolean;
  unreadableFolders: number;
};

type ConversionOutput = {
  source: string;
  path: string;
  name: string;
  bytes: number;
};

type RunTaskResult = {
  outputs: ConversionOutput[];
  warnings: string[];
};

type SaveResult = {
  saved: string[];
};

type QueueState = "ready" | "working" | "converted" | "saved" | "failed";

type QueueItem = FileEntry & {
  state: QueueState;
  message: string;
};

type TaskRequest = {
  runId: string;
  taskFunction: TaskFunction;
  outputType: string;
  paths: string[];
  detail: string;
};

type TaskProgress = {
  runId: string;
  completed: number;
  total: number;
  message: string;
};

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const functionSelect = element<HTMLSelectElement>("task-function");
const outputSelect = element<HTMLSelectElement>("output-type");
const detailControls = element<HTMLElement>("detail-controls");
const pageRangesField = element<HTMLElement>("page-ranges-field");
const pageRangesInput = element<HTMLInputElement>("page-ranges");
const rotatePagesField = element<HTMLElement>("rotate-pages-field");
const rotatePagesMode = element<HTMLSelectElement>("rotate-pages-mode");
const rotatePagesStatic = element<HTMLElement>("rotate-pages-static");
const rotatePagesPrompt = element<HTMLElement>("rotate-pages-prompt");
const rotatePagesInput = element<HTMLInputElement>("rotate-pages");
const dropZone = element<HTMLElement>("drop-zone");
const importButton = element<HTMLButtonElement>("import-files");
const browserFileInput = element<HTMLInputElement>("browser-file-input");
const queueFrame = element<HTMLElement>("queue-frame");
const rowsBody = element<HTMLTableSectionElement>("file-rows");
const emptyQueue = element<HTMLElement>("empty-queue");
const clearButton = element<HTMLButtonElement>("clear");
const removeSelectedButton = element<HTMLButtonElement>("remove-selected");
const convertButton = element<HTMLButtonElement>("convert");
const saveButton = element<HTMLButtonElement>("save");
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const notice = element<HTMLElement>("notice");
const noticeTitle = element<HTMLElement>("notice-title");
const noticeCopy = element<HTMLElement>("notice-copy");
const dismissNotice = element<HTMLButtonElement>("dismiss-notice");
const noticeActions = element<HTMLElement>("notice-actions");
const noticeCancel = element<HTMLButtonElement>("notice-cancel");
const noticeConfirm = element<HTMLButtonElement>("notice-confirm");
const saveDialog = element<HTMLElement>("save-dialog");
const dismissSave = element<HTMLButtonElement>("dismiss-save");
const saveSummary = element<HTMLElement>("save-summary");
const saveDestinationLabel = element<HTMLElement>("save-destination-label");
const saveDestination = element<HTMLInputElement>("save-destination");
const saveConflict = element<HTMLElement>("save-conflict");
const changeSaveFolder = element<HTMLButtonElement>("change-save-folder");
const cancelSave = element<HTMLButtonElement>("cancel-save");
const overwriteSave = element<HTMLButtonElement>("overwrite-save");
const applySave = element<HTMLButtonElement>("apply-save");

const isTauri = "__TAURI_INTERNALS__" in window;
let queue: QueueItem[] = [];
let outputs: ConversionOutput[] = [];
let busy = false;
let importing = false;
let pickerOpen = false;
let saved = false;
let draggingPath = "";
let selectedPaths = new Set<string>();
let selectionAnchorPath = "";
let selectionFocusPath = "";
let importEpoch = 0;
let noticeResolver: ((confirmed: boolean) => void) | null = null;
let noticePersistent = false;
let activeRunId = "";
let cancellationRequested = false;
let activeEligiblePaths: string[] = [];
let activeDraggedPopup: HTMLElement | null = null;
let pendingDraggedPopup: HTMLElement | null = null;
let popupPointerId = -1;
let popupDragStartX = 0;
let popupDragStartY = 0;
let popupDragOffsetX = 0;
let popupDragOffsetY = 0;

function selectedFunction(): TaskFunction | null {
  return functionSelect.value ? functionSelect.value as TaskFunction : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim() !== "") return error;
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

function currentDetail(): string {
  const task = selectedFunction();
  if (task === "split" && outputSelect.value === "ranges") return pageRangesInput.value.trim();
  if (task === "rotate") return rotatePagesMode.value === "all" ? "all" : rotatePagesInput.value.trim();
  return "";
}

function centerPopup(popup: HTMLElement): void {
  popup.style.left = "50%";
  popup.style.top = "50%";
  popup.style.transform = "translate(-50%, -50%)";
}

function centerNotice(): void {
  centerPopup(notice);
}

function settleNotice(confirmed: boolean): void {
  const resolver = noticeResolver;
  noticeResolver = null;
  if (resolver) resolver(confirmed);
}

function showNotice(message: string, error = false, persistent = false): void {
  settleNotice(false);
  noticePersistent = persistent;
  noticeTitle.textContent = error ? "Error" : "Message";
  noticeCopy.textContent = message;
  notice.classList.toggle("error", error);
  noticeActions.hidden = true;
  dismissNotice.hidden = false;
  noticeConfirm.hidden = false;
  centerNotice();
  notice.hidden = false;
}

function hideNotice(force = false): void {
  if (noticePersistent && !force) return;
  noticePersistent = false;
  notice.hidden = true;
  settleNotice(false);
}

function closeSaveDialog(): void {
  saveDialog.hidden = true;
  saveConflict.hidden = true;
  overwriteSave.hidden = true;
  activeDraggedPopup = null;
}

function showSaveDialog(): void {
  if (outputs.length === 0 || busy) return;
  hideNotice();
  saveDestination.value = "";
  saveSummary.textContent = `${outputs.length} Converted File${outputs.length === 1 ? "" : "s"} to Save.`;
  saveDestinationLabel.textContent = outputs.length === 1 ? "Save To (Folder and Filename)" : "Destination Folder";
  saveDestination.placeholder = outputs.length === 1 ? "Type or Select a Folder and Filename" : "Type or Select a Folder Path";
  saveConflict.hidden = true;
  overwriteSave.hidden = true;
  applySave.disabled = true;
  centerPopup(saveDialog);
  saveDialog.hidden = false;
  saveDestination.focus();
}

function confirmNotice(message: string, confirmLabel: string): Promise<boolean> {
  settleNotice(false);
  noticePersistent = false;
  noticeTitle.textContent = "Confirmation";
  noticeCopy.textContent = message;
  notice.classList.remove("error");
  noticeConfirm.textContent = confirmLabel;
  noticeActions.hidden = false;
  dismissNotice.hidden = false;
  noticeCancel.disabled = false;
  noticeCancel.textContent = "Cancel";
  noticeConfirm.hidden = false;
  centerNotice();
  notice.hidden = false;
  return new Promise((resolve) => {
    noticeResolver = resolve;
  });
}

function readyForImport(): boolean {
  return importIsReady({
    task: selectedFunction(),
    outputType: outputSelect.value,
    pageRanges: pageRangesInput.value,
    rotatePages: rotatePagesInput.value,
    pickerOpen,
    importing,
  });
}

function validDetails(): boolean {
  return validImportDetails(
    selectedFunction(),
    outputSelect.value,
    pageRangesInput.value,
    rotatePagesInput.value,
    rotatePagesMode.value as RotatePageMode,
  );
}

function invalidDetailsMessage(task: TaskFunction): string {
  if (task === "split") return "Enter valid page ranges such as 1-3, 5, 8-10.";
  if (task === "rotate" && rotatePagesMode.value === "single") return "Enter a valid page number.";
  if (task === "rotate" && rotatePagesMode.value === "range") return "Enter a valid page range such as 3-5.";
  return "Check the selected options.";
}

function resetConvertedState(): void {
  outputs = [];
  saved = false;
  queue = queue.map((item) => ({ ...item, state: "ready", message: "Ready" }));
}

function clearSelection(): void {
  selectedPaths.clear();
  selectionAnchorPath = "";
  selectionFocusPath = "";
}

async function discardOutputs(): Promise<void> {
  const paths = outputs.map((output) => output.path);
  if (paths.length > 0 && isTauri) {
    try {
      await invoke("discard_outputs", { paths });
    } catch {
      showNotice("Some Temporary Files Could Not Be Removed.", true, true);
    }
  }
  resetConvertedState();
}

function updateDetailControls(): void {
  const task = selectedFunction();
  const showRanges = task === "split" && outputSelect.value === "ranges";
  const showRotate = task === "rotate" && outputSelect.value !== "";
  pageRangesField.hidden = !showRanges;
  rotatePagesField.hidden = !showRotate;
  const rotateMode = rotatePagesMode.value as RotatePageMode;
  const showRotateValue = showRotate && rotateMode !== "all";
  rotatePagesStatic.hidden = !showRotate || rotateMode !== "all";
  rotatePagesPrompt.hidden = !showRotateValue;
  rotatePagesInput.hidden = !showRotateValue;
  rotatePagesPrompt.textContent = rotateMode === "single" ? "Enter Page Number:" : "Enter Page Range:";
  rotatePagesInput.inputMode = rotateMode === "single" ? "numeric" : "text";
  detailControls.hidden = !showRanges && !showRotate;
}

function populateOutputChoices(): void {
  outputSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a Type";
  placeholder.disabled = true;
  placeholder.selected = true;
  outputSelect.append(placeholder);

  const task = selectedFunction();
  outputSelect.disabled = !task;
  if (task) {
    for (const choice of outputChoices(task)) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      outputSelect.append(option);
    }
  }
  updateDetailControls();
}

function rowStatus(item: QueueItem, task: TaskFunction | null): { label: string; className: string } {
  if (task && !acceptsExtension(task, item.extension)) return { label: "Unsupported", className: "failed" };
  if (item.state === "working") return { label: "Converting", className: "working" };
  if (item.state === "converted") return { label: "Converted", className: "" };
  if (item.state === "saved") return { label: "Saved", className: "" };
  if (item.state === "failed") return { label: "Failed", className: "failed" };
  return { label: "Ready", className: "" };
}

function convertedBytesFor(item: QueueItem): number | null {
  const directOutputs = outputs.filter((output) => output.source === item.path);
  if (directOutputs.length > 0) {
    return directOutputs.reduce((total, output) => total + output.bytes, 0);
  }
  return null;
}

function hasCombinedOutput(): boolean {
  const task = selectedFunction();
  return outputs.length > 0 && (task === "merge" || (task === "to-pdf" && outputSelect.value === "combined"));
}

function setSelection(index: number, extendRange: boolean, preserveSelection: boolean): void {
  const item = queue[index];
  if (!item || busy) return;
  const next = selectQueueIndex(
    queue.map((entry) => entry.path),
    { selected: selectedPaths, anchor: selectionAnchorPath, focus: selectionFocusPath },
    index,
    extendRange,
    preserveSelection,
  );
  selectedPaths = next.selected;
  selectionAnchorPath = next.anchor;
  selectionFocusPath = next.focus;
  render();
  queueFrame.focus({ preventScroll: true });
}

function selectWithArrow(direction: -1 | 1, extendRange: boolean, preserveSelection: boolean): void {
  if (queue.length === 0 || busy) return;
  const next = selectQueueArrow(
    queue.map((entry) => entry.path),
    { selected: selectedPaths, anchor: selectionAnchorPath, focus: selectionFocusPath },
    direction,
    extendRange,
    preserveSelection,
  );
  selectedPaths = next.selected;
  selectionAnchorPath = next.anchor;
  selectionFocusPath = next.focus;
  render();
  queueFrame.focus({ preventScroll: true });
}

function selectAll(): void {
  if (queue.length === 0 || busy) return;
  const next = selectEveryQueuePath(queue.map((item) => item.path));
  selectedPaths = next.selected;
  selectionAnchorPath = next.anchor;
  selectionFocusPath = next.focus;
  render();
  queueFrame.focus({ preventScroll: true });
}

function combinedOrderEnabled(): boolean {
  const task = selectedFunction();
  return !busy && (task === "merge" || (task === "to-pdf" && outputSelect.value === "combined"));
}

function moveQueueItem(source: string, before: string): void {
  if (source === before) return;
  const sourceIndex = queue.findIndex((item) => item.path === source);
  const beforeIndex = queue.findIndex((item) => item.path === before);
  if (sourceIndex < 0 || beforeIndex < 0) return;
  const [item] = queue.splice(sourceIndex, 1);
  const nextIndex = queue.findIndex((entry) => entry.path === before);
  queue.splice(nextIndex, 0, item!);
  resetConvertedState();
  render();
}

function moveQueueItemByOffset(path: string, offset: -1 | 1): void {
  const sourceIndex = queue.findIndex((item) => item.path === path);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= queue.length) return;
  [queue[sourceIndex], queue[targetIndex]] = [queue[targetIndex]!, queue[sourceIndex]!];
  resetConvertedState();
  render();
}

function renderRows(): void {
  rowsBody.replaceChildren();
  const task = selectedFunction();
  const draggable = combinedOrderEnabled();

  for (const [index, item] of queue.entries()) {
    const row = document.createElement("tr");
    row.dataset.path = item.path;
    row.draggable = draggable;
    row.classList.toggle("selected", selectedPaths.has(item.path));
    row.setAttribute("aria-selected", String(selectedPaths.has(item.path)));
    row.title = draggable ? `${item.path}\nDrag to Reorder` : item.path;
    row.addEventListener("mousedown", (event) => {
      if (event.button === 0 && event.shiftKey && !(event.target as HTMLElement).closest("button")) {
        event.preventDefault();
      }
    });
    row.addEventListener("click", (event) => {
      setSelection(index, event.shiftKey, event.metaKey || event.ctrlKey);
    });

    if (draggable) {
      row.addEventListener("dragstart", () => {
        draggingPath = item.path;
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        draggingPath = "";
        row.classList.remove("dragging");
        rowsBody.querySelectorAll(".drag-over").forEach((entry) => entry.classList.remove("drag-over"));
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("drag-over");
        if (draggingPath) moveQueueItem(draggingPath, item.path);
      });
    }

    const typeCell = document.createElement("td");
    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = extensionLabel(item.extension);
    typeCell.append(type);

    const nameCell = document.createElement("td");
    nameCell.className = "file-name";
    nameCell.title = item.path;
    if (draggable) {
      const orderControls = document.createElement("span");
      orderControls.className = "order-controls";
      const moveUp = document.createElement("button");
      moveUp.type = "button";
      moveUp.className = "order-button";
      moveUp.textContent = "↑";
      moveUp.title = `Move ${item.name} Up`;
      moveUp.setAttribute("aria-label", `Move ${item.name} Up`);
      moveUp.disabled = index === 0;
      moveUp.addEventListener("click", (event) => {
        event.stopPropagation();
        moveQueueItemByOffset(item.path, -1);
      });
      const moveDown = document.createElement("button");
      moveDown.type = "button";
      moveDown.className = "order-button";
      moveDown.textContent = "↓";
      moveDown.title = `Move ${item.name} Down`;
      moveDown.setAttribute("aria-label", `Move ${item.name} Down`);
      moveDown.disabled = index === queue.length - 1;
      moveDown.addEventListener("click", (event) => {
        event.stopPropagation();
        moveQueueItemByOffset(item.path, 1);
      });
      orderControls.append(moveUp, moveDown);
      nameCell.append(orderControls);
    }
    const fileName = document.createElement("span");
    fileName.textContent = item.name;
    nameCell.append(fileName);

    const sizeCell = document.createElement("td");
    sizeCell.className = "file-size";
    const convertedBytes = convertedBytesFor(item);
    const combined = hasCombinedOutput()
      && acceptsExtension(task!, item.extension)
      && (item.state === "converted" || item.state === "saved");
    sizeCell.textContent = `${formatBytes(item.bytes)} / ${combined ? "Combined" : convertedBytes === null ? "—" : formatBytes(convertedBytes)}`;
    sizeCell.title = convertedBytes === null
      ? combined ? "Original Size / Included in Combined Output" : "Original Size / New Size"
      : `Original: ${formatBytes(item.bytes)} · New: ${formatBytes(convertedBytes)}`;

    const statusCell = document.createElement("td");
    const status = rowStatus(item, task);
    const statusLabel = document.createElement("span");
    statusLabel.className = ["row-status", status.className].filter(Boolean).join(" ");
    statusLabel.textContent = status.label;
    statusLabel.title = item.message;
    statusCell.append(statusLabel);

    const removeCell = document.createElement("td");
    removeCell.className = "remove-cell";
    const remove = document.createElement("button");
    remove.className = "row-remove-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.disabled = busy;
    remove.title = `Remove ${item.name}`;
    remove.setAttribute("aria-label", `Remove ${item.name} from Queue`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeQueuePath(item.path);
    });
    removeCell.append(remove);

    row.append(typeCell, nameCell, sizeCell, statusCell, removeCell);
    rowsBody.append(row);
  }
}

function renderControls(): void {
  const functionChosen = Boolean(selectedFunction());
  importButton.disabled = !readyForImport();
  dropZone.classList.toggle("busy", !readyForImport());
  functionSelect.disabled = busy || importing;
  outputSelect.disabled = busy || importing || !selectedFunction();
  pageRangesInput.disabled = busy || importing;
  rotatePagesMode.disabled = busy || importing;
  rotatePagesInput.disabled = busy || importing || rotatePagesInput.hidden;
  pageRangesInput.setAttribute("aria-invalid", String(!pageRangesField.hidden && !validImportDetails("split", "ranges", pageRangesInput.value, "")));
  rotatePagesInput.setAttribute("aria-invalid", String(!rotatePagesInput.hidden && !validImportDetails("rotate", outputSelect.value, "", rotatePagesInput.value, rotatePagesMode.value as RotatePageMode)));
  clearButton.disabled = busy || importing || !clearIsEnabled(queue.length);
  removeSelectedButton.disabled = busy || importing || !removeSelectedIsEnabled(selectedPaths.size);
  removeSelectedButton.textContent = `Remove Selected (${selectedPaths.size})`;
  convertButton.disabled = busy
    ? cancellationRequested || activeRunId === ""
    : !functionChosen || queue.length === 0;
  saveButton.disabled = busy || outputs.length === 0;
  convertButton.textContent = busy ? cancellationRequested ? "Cancelling" : "Cancel" : "Convert";
  convertButton.classList.remove("reconvert");
}

function render(): void {
  emptyQueue.hidden = queue.length > 0;
  renderRows();
  renderControls();
}

async function removeQueuePath(path: string): Promise<void> {
  if (busy) return;
  if (outputs.length > 0) await discardOutputs();
  queue = queue.filter((item) => item.path !== path);
  selectedPaths.delete(path);
  if (selectionAnchorPath === path) selectionAnchorPath = "";
  if (selectionFocusPath === path) selectionFocusPath = "";
  hideNotice();
  render();
}

function emptyQueueState(): void {
  queue = [];
  selectedPaths.clear();
  selectionAnchorPath = "";
  selectionFocusPath = "";
}

async function removeSelectedItems(): Promise<void> {
  if (busy || importing || selectedPaths.size === 0) return;
  if (outputs.length > 0) await discardOutputs();
  queue = queue.filter((item) => !selectedPaths.has(item.path));
  selectedPaths.clear();
  selectionAnchorPath = "";
  selectionFocusPath = "";
  hideNotice();
  render();
}

async function addCollectedFiles(collected: CollectedFiles): Promise<void> {
  const { fresh, duplicateNames } = partitionImportCandidates(collected.files, queue.map((item) => item.path));

  if (fresh.length > 0 && outputs.length > 0) await discardOutputs();
  queue.push(...fresh.map((file) => ({ ...file, state: "ready" as const, message: "Ready" })));

  const ignored = collected.ignored;
  const notices: string[] = [];
  if (duplicateNames.length > 0) notices.push(duplicateNotice(duplicateNames));
  if (collected.truncated) notices.push("20,000 file limit reached. Remaining files were not added.");
  if (collected.folderDepthLimited) notices.push("Some nested folders were deeper than the eight-level limit.");
  if (collected.unreadableFolders > 0) notices.push("Some folders could not be read.");
  if (ignored > 0) notices.push(`${ignored} unsupported file${ignored === 1 ? " was" : "s were"} ignored.`);

  if (notices.length > 0) showNotice(notices.join(" "));
  else if (fresh.length === 0) showNotice("No compatible files were found for this function.");
  else hideNotice();
}

async function addPaths(paths: string[]): Promise<void> {
  const requestEpoch = importEpoch;
  importing = true;
  render();
  try {
    const collected = await invoke<CollectedFiles>("collect_files", { paths });
    if (requestEpoch === importEpoch) await addCollectedFiles(collected);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Selected Files Could Not Be Read.", true);
  } finally {
    importing = false;
    render();
  }
}

async function addBrowserFiles(files: File[]): Promise<void> {
  if (!readyForImport()) return;
  importing = true;
  render();
  try {
    const entries = files.map((file) => {
      const nameParts = file.name.split(".");
      const extension = nameParts.length > 1 ? nameParts.pop()!.toLowerCase() : "";
      const relativeName = file.webkitRelativePath || file.name;
      return {
        path: `browser:${relativeName}:${file.size}:${file.lastModified}`,
        name: file.name,
        bytes: file.size,
        extension,
      };
    });
    await addCollectedFiles({
      files: entries,
      ignored: 0,
      truncated: false,
      folderDepthLimited: false,
      unreadableFolders: 0,
    });
  } finally {
    importing = false;
    render();
  }
}

async function chooseFiles(): Promise<void> {
  if (!readyForImport()) return;
  const task = selectedFunction();
  const extensions = allowedImportExtensions(task);

  if (!isTauri) {
    browserFileInput.accept = extensions.map((extension) => `.${extension}`).join(",");
    browserFileInput.value = "";
    pickerOpen = true;
    renderControls();
    const closePicker = () => {
      window.setTimeout(() => {
        pickerOpen = false;
        render();
      }, 0);
    };
    window.addEventListener("focus", closePicker, { once: true });
    browserFileInput.click();
    return;
  }

  pickerOpen = true;
  renderControls();
  try {
    const chosen = await open({
      multiple: true,
      title: "Import Files",
      filters: [{ name: !task || task === "to-pdf" ? "Documents" : "PDF Documents", extensions }],
    });
    const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
    if (paths.length > 0) await addPaths(paths);
  } catch {
    showNotice("The File Picker Could Not Be Opened.", true);
  } finally {
    pickerOpen = false;
    render();
  }
}

async function runTask(): Promise<void> {
  const task = selectedFunction();
  if (!task || busy) return;
  if (!outputSelect.value) {
    showNotice("Please Select an Output Type.");
    return;
  }
  const validationCompatible = queue.filter((item) => acceptsExtension(task, item.extension));
  const validationCandidates = outputs.length > 0
    ? validationCompatible.map((item) => ({ ...item, state: "ready" as const }))
    : validationCompatible;
  const issue = conversionIssue(task, validationCandidates, selectedPaths);
  if (issue) {
    showNotice(issue);
    return;
  }
  if (!validDetails()) {
    showNotice(invalidDetailsMessage(task));
    return;
  }
  if (!isTauri) {
    showNotice("Conversion Is Available in the Quire Desktop App.");
    return;
  }

  if (outputs.length > 0) await discardOutputs();
  const compatible = queue.filter((item) => acceptsExtension(task, item.extension));
  const eligible = conversionTargets(task, compatible, selectedPaths);
  if (eligible.length === 0) return;
  const eligiblePaths = new Set(eligible.map((item) => item.path));
  cancellationRequested = false;
  busy = true;
  queue = queue.map((item) => eligiblePaths.has(item.path)
    ? { ...item, state: "working", message: "Converting" }
    : item);
  hideNotice();
  render();

  const createRequest = (paths: string[]): TaskRequest => ({
    runId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    taskFunction: task,
    outputType: outputSelect.value,
    paths,
    detail: currentDetail(),
  });
  const combinedTransaction = task === "merge" || task === "split" || (task === "to-pdf" && outputSelect.value === "combined");
  const convertedOutputs: ConversionOutput[] = [];
  let failedCount = 0;
  const failureMessages: string[] = [];
  let cancelled = false;

  try {
    const batches = combinedTransaction ? [eligible] : eligible.map((item) => [item]);
    for (const batch of batches) {
      if (cancellationRequested) {
        cancelled = true;
        break;
      }
      const paths = batch.map((item) => item.path);
      const request = createRequest(paths);
      activeRunId = request.runId;
      activeEligiblePaths = paths;
      renderControls();
      try {
        const result = await invoke<RunTaskResult>("run_task", { request });
        convertedOutputs.push(...result.outputs);
        const completed = new Set(paths);
        queue = queue.map((item) => completed.has(item.path)
          ? { ...item, state: "converted", message: "Converted" }
          : item);
      } catch (error) {
        const message = errorMessage(error, "Conversion Failed.");
        if (message === "Conversion Cancelled.") {
          cancelled = true;
          break;
        }
        failedCount += batch.length;
        failureMessages.push(message);
        const failed = new Set(paths);
        queue = queue.map((item) => failed.has(item.path)
          ? { ...item, state: "failed", message }
          : item);
      }
      renderRows();
    }
    outputs = convertedOutputs;
    saved = false;
    if (cancelled) hideNotice();
    else if (failedCount > 0) {
      const uniqueMessages = [...new Set(failureMessages)];
      const message = uniqueMessages.length === 1
        ? uniqueMessages[0]!
        : `${failedCount} Files Could Not Be Converted.`;
      showNotice(message, true);
    }
    else hideNotice();
  } finally {
    queue = queue.map((item) => item.state === "working"
      ? { ...item, state: "ready", message: "Ready" }
      : item);
    activeRunId = "";
    activeEligiblePaths = [];
    cancellationRequested = false;
    busy = false;
    render();
  }
}

async function applySaveResults(overwrite = false): Promise<void> {
  if (busy || outputs.length === 0 || !isTauri) return;
  const destination = saveDestination.value.trim();
  if (destination === "") return;
  saveConflict.hidden = true;
  overwriteSave.hidden = true;
  busy = true;
  applySave.disabled = true;
  overwriteSave.disabled = true;
  render();
  try {
    await invoke<SaveResult>("save_outputs", { paths: outputs.map((output) => output.path), destination, overwrite });
    const savedSourcePaths = new Set(outputs.map((output) => output.source).filter(Boolean));
    const savedCombinedOutput = outputs.some((output) => output.source === "");
    saved = true;
    queue = queue.map((item) => (savedCombinedOutput && item.state === "converted") || savedSourcePaths.has(item.path)
      ? { ...item, state: "saved", message: "Saved" }
      : item);
    closeSaveDialog();
    hideNotice();
  } catch (error) {
    const message = errorMessage(error, "Converted Files Could Not Be Saved.");
    const existingPath = message.startsWith("FILE_EXISTS::") ? message.slice("FILE_EXISTS::".length) : "";
    saveConflict.textContent = existingPath
      ? outputs.length === 1
        ? `A file named "${existingPath.split("/").pop() ?? existingPath}" already exists. Overwrite it or choose a different filename.`
        : "One or more files already exist. Overwrite them or choose a different folder."
      : message;
    saveConflict.hidden = false;
    overwriteSave.hidden = existingPath === "";
  } finally {
    busy = false;
    applySave.disabled = saveDestination.value.trim() === "";
    overwriteSave.disabled = false;
    render();
  }
}

async function clearQueue(): Promise<void> {
  if (busy || importing) return;
  importEpoch += 1;
  importing = false;
  if (outputs.length > 0 && !saved) {
    const discard = await confirmNotice("Discard the converted files that have not been saved?", "Discard");
    if (!discard) return;
  }
  await discardOutputs();
  emptyQueueState();
  hideNotice();
  render();
}

async function changeFunction(): Promise<void> {
  importEpoch += 1;
  importing = false;
  await discardOutputs();
  clearSelection();
  pageRangesInput.value = "";
  rotatePagesMode.value = "all";
  rotatePagesInput.value = "";
  populateOutputChoices();
  hideNotice();
  render();
}

async function changeOutput(): Promise<void> {
  await discardOutputs();
  clearSelection();
  updateDetailControls();
  hideNotice();
  render();
}

async function changeRotatePageMode(): Promise<void> {
  await discardOutputs();
  clearSelection();
  rotatePagesInput.value = "";
  updateDetailControls();
  hideNotice();
  render();
  if (!rotatePagesInput.hidden) rotatePagesInput.focus();
}

async function changeRotatePageValue(): Promise<void> {
  await discardOutputs();
  clearSelection();
  hideNotice();
  render();
}

functionSelect.addEventListener("change", () => void changeFunction());

outputSelect.addEventListener("change", () => {
  void changeOutput();
});

pageRangesInput.addEventListener("input", renderControls);
rotatePagesMode.addEventListener("change", () => {
  void changeRotatePageMode();
});
rotatePagesInput.addEventListener("input", () => void changeRotatePageValue());
importButton.addEventListener("click", () => void chooseFiles());
browserFileInput.addEventListener("change", () => {
  const files = Array.from(browserFileInput.files ?? []);
  pickerOpen = false;
  if (files.length > 0) void addBrowserFiles(files);
  else render();
});
async function cancelActiveTask(): Promise<void> {
  if (!busy || !activeRunId || cancellationRequested) return;
  cancellationRequested = true;
  renderControls();
  try {
    await invoke("cancel_task", { runId: activeRunId });
  } catch {
    cancellationRequested = false;
    showNotice("The Conversion Could Not Be Cancelled.", true);
    renderControls();
  }
}

convertButton.addEventListener("click", () => {
  if (busy) void cancelActiveTask();
  else void runTask();
});
saveButton.addEventListener("click", showSaveDialog);
clearButton.addEventListener("click", () => void clearQueue());
removeSelectedButton.addEventListener("click", () => void removeSelectedItems());
dismissNotice.addEventListener("click", () => hideNotice(true));
noticeCancel.addEventListener("click", () => {
  hideNotice(true);
});
noticeConfirm.addEventListener("click", () => {
  noticePersistent = false;
  notice.hidden = true;
  settleNotice(true);
});

dismissSave.addEventListener("click", closeSaveDialog);
cancelSave.addEventListener("click", closeSaveDialog);
saveDestination.addEventListener("input", () => {
  saveConflict.hidden = true;
  overwriteSave.hidden = true;
  applySave.disabled = saveDestination.value.trim() === "";
});
saveDestination.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || applySave.disabled) return;
  event.preventDefault();
  void applySaveResults(false);
});
changeSaveFolder.addEventListener("click", async () => {
  if (!isTauri || pickerOpen) return;
  pickerOpen = true;
  renderControls();
  try {
    const chosen = await open({ directory: true, multiple: false, title: "Choose a Destination Folder" });
    if (typeof chosen === "string") {
      saveDestination.value = outputs.length === 1
        ? `${chosen.replace(/\/$/, "")}/${outputs[0]!.name}`
        : chosen;
    }
    saveConflict.hidden = true;
    overwriteSave.hidden = true;
    applySave.disabled = saveDestination.value.trim() === "";
  } catch {
    closeSaveDialog();
    showNotice("The Destination Folder Picker Could Not Be Opened.", true);
  } finally {
    pickerOpen = false;
    renderControls();
  }
});
overwriteSave.addEventListener("click", () => void applySaveResults(true));
applySave.addEventListener("click", () => void applySaveResults(false));

function pointTouchesText(container: HTMLElement, x: number, y: number): boolean {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
    node = walker.nextNode();
  }
  return false;
}

function beginPopupDrag(popup: HTMLElement, event: PointerEvent): void {
  if ((event.target as HTMLElement).closest("button, input, select, textarea, label")) return;
  const selectableText = (event.target as HTMLElement).closest<HTMLElement>(".notice-copy, .save-copy p");
  if (selectableText && pointTouchesText(selectableText, event.clientX, event.clientY)) return;
  pendingDraggedPopup = popup;
  popupPointerId = event.pointerId;
  popupDragStartX = event.clientX;
  popupDragStartY = event.clientY;
}

function movePopup(event: PointerEvent): void {
  if (!activeDraggedPopup && pendingDraggedPopup && event.pointerId === popupPointerId) {
    const distance = Math.hypot(event.clientX - popupDragStartX, event.clientY - popupDragStartY);
    if (distance < 5) return;
    const popupRect = pendingDraggedPopup.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    activeDraggedPopup = pendingDraggedPopup;
    pendingDraggedPopup = null;
    popupDragOffsetX = popupDragStartX - popupRect.left;
    popupDragOffsetY = popupDragStartY - popupRect.top;
    activeDraggedPopup.style.transform = "none";
    activeDraggedPopup.style.left = `${popupRect.left - workspaceRect.left}px`;
    activeDraggedPopup.style.top = `${popupRect.top - workspaceRect.top}px`;
    activeDraggedPopup.setPointerCapture(event.pointerId);
  }
  if (!activeDraggedPopup) return;
  const workspaceRect = workspace.getBoundingClientRect();
  const popupRect = activeDraggedPopup.getBoundingClientRect();
  const left = Math.max(0, Math.min(workspaceRect.width - popupRect.width, event.clientX - workspaceRect.left - popupDragOffsetX));
  const top = Math.max(0, Math.min(workspaceRect.height - popupRect.height, event.clientY - workspaceRect.top - popupDragOffsetY));
  activeDraggedPopup.style.left = `${left}px`;
  activeDraggedPopup.style.top = `${top}px`;
  event.preventDefault();
}

function stopPopupDrag(event: PointerEvent): void {
  pendingDraggedPopup = null;
  popupPointerId = -1;
  if (!activeDraggedPopup) return;
  if (activeDraggedPopup.hasPointerCapture(event.pointerId)) activeDraggedPopup.releasePointerCapture(event.pointerId);
  activeDraggedPopup = null;
}

for (const popup of [notice, saveDialog]) {
  popup.addEventListener("pointerdown", (event) => beginPopupDrag(popup, event));
  popup.addEventListener("pointermove", movePopup);
  popup.addEventListener("pointerup", stopPopupDrag);
  popup.addEventListener("pointercancel", stopPopupDrag);
}

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  const editing = target?.matches("input, select, textarea, [contenteditable='true']") ?? false;
  if (editing || busy || queue.length === 0) return;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAll();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    selectWithArrow(event.key === "ArrowUp" ? -1 : 1, event.shiftKey, event.metaKey || event.ctrlKey);
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && selectedPaths.size > 0) {
    event.preventDefault();
    void removeSelectedItems();
  }
});

if (isTauri) {
  void listen<TaskProgress>("task-progress", ({ payload }) => {
    if (payload.runId !== activeRunId) return;
    const activePaths = new Set(activeEligiblePaths);
    queue = queue.map((item) => activePaths.has(item.path)
      ? { ...item, message: `${payload.message}: ${payload.completed} of ${payload.total}` }
      : item);
    renderRows();
  });
  void listen<{ paths: string[] }>("tauri://drag-drop", ({ payload }) => {
    dropZone.classList.remove("over");
    if (readyForImport()) void addPaths(payload.paths);
    else showNotice("Choose a Function and Choose a Type Before Importing Files.");
  });
  void listen("tauri://drag-enter", () => {
    if (readyForImport()) dropZone.classList.add("over");
  });
  void listen("tauri://drag-leave", () => dropZone.classList.remove("over"));
}

populateOutputChoices();
render();
