# Conflict Resolution

A conflict happens when you edit the same file on two devices before they've had a chance to sync. For example, you edit a note on your laptop, then edit the same note on your phone before the laptop syncs.

## Choosing a strategy

Go to **Settings > Dropbox Sync > Conflict strategy** to pick how conflicts are handled.

### Keep both (default)

Both versions are saved. Your local version stays as-is, and the other device's version is saved next to it with a `.conflict` suffix:

```
notes/idea.md                          ← your version (untouched)
notes/idea.conflict-20260306T143200.md ← the other device's version
```

You can compare them at your own pace, merge what you need, and delete the `.conflict` file when done.

When the conflicted note is open, the status bar shows a conflict icon. Click it for a short explanation and **Compare**, which opens your version and the Dropbox copy in a split (side-by-side on wide viewports, stacked on tall ones). See [Per-file status bar](per-file-status-bar.md).

### Keep newest

The version that was edited most recently wins. The older version is overwritten.

This is the simplest option, but it can lose changes if both devices made important edits. Best when you typically only edit on one device at a time.

### Ask me

A comparison window opens so you can decide section by section.

<!-- TODO: 스크린샷 — 텍스트 파일 머지 모달 (conflict 블록 + 선택 상태) -->
<!-- 파일: docs/images/merge-modal.png, 권장 크기: 800px 너비 -->

**For text files**, you see a side-by-side view:

- Sections that are the same on both devices are shown in gray
- Sections that differ are highlighted — click one to choose **your version**, **the other version**, or **both**
- A counter at the bottom shows how many sections still need your decision
- When you're ready, click **Save**

You can also click **Keep all local** or **Keep all remote** to quickly resolve everything at once.

<!-- TODO: 스크린샷 — 이미지 파일 비교 모달 (두 이미지 나란히) -->
<!-- 파일: docs/images/image-compare.png -->

**For images**, you see both versions side by side with their file sizes, so you can pick the right one visually.

**For other files** (PDFs, etc.), you see file sizes and modification dates to help you decide.

**Not sure yet?** Click the clock icon to skip this conflict for now. It will come back on the next sync.

## Tips

- **Conflicts are rare** if you wait a few seconds for sync to complete before switching devices
- If conflicts keep appearing for the same file, it usually means two devices are editing it at the same time — try editing on one device at a time
- `.conflict` files are regular files — you can open, edit, and delete them normally
