/**
 * Every string the interface can render, as one shape both languages have to
 * satisfy. A missing key is a type error, not a string that silently falls
 * back to another language at runtime — which is the entire reason this is a
 * typed object instead of a bag of lookup keys.
 *
 * It starts small on purpose: the redesign is rewriting most screens, and
 * each phase moves its own copy in here as it rewrites it, rather than
 * translating text that is about to be deleted. `common` is the slice that
 * survives any redesign — the verbs on buttons.
 */
import type { EditMessageErrorCode, SetCwdErrorCode } from "@/lib/relay/relay-types";

/** Every permission-mode id this build has real copy for, across every
 * agent — a closed union HERE (so `en`/`pt-br` can't drift) even though the
 * wire value (`PermissionMode`, relay-types.ts) is an opaque string: the
 * real vocabulary is per-agent and per-platform, which this dictionary
 * can't enumerate exhaustively without also knowing every def. Resolved
 * defensively at the call site instead (`PermissionModeButton`'s
 * `useModeCopy`) — an id this build doesn't know renders as itself, not a
 * compile error. Claude's four, Codex's three. */
export type KnownPermissionModeId = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "read-only" | "workspace-write" | "full-access";

/** Every agent id this build has a display name for — resolved defensively
 * at the call site (`AgentPickerButton`), same id-switch-with-fallback shape
 * as `KnownPermissionModeId` above. Product names, so `en`/`pt-br` carry the
 * identical string — still dictionary entries, not a literal in the
 * component, per this repo's "any string rendered to a user lives in the
 * dictionary" rule. */
export type KnownAgentId = "claude" | "codex";
import type { ThemeValidationCode } from "@/lib/theme/theme";
import type { FirstRunScreen } from "@/lib/profiles/firstRun";
import type { InstallRowKey, LocalFailureAction, LocalFailureCode, LocalNote, LocalStep } from "@/lib/install/localInstall";

export interface Dictionary {
  common: {
    add: string;
    back: string;
    cancel: string;
    close: string;
    copy: string;
    create: string;
    delete: string;
    download: string;
    edit: string;
    loading: string;
    remove: string;
    rename: string;
    retry: string;
    save: string;
    search: string;
    send: string;
    stop: string;
    /** Fallback name for a session the relay hasn't titled yet (`title` is
     * still `null`). Lives in `common` rather than under a surface because
     * it is the session's own identity, and five surfaces render it: the
     * tab, its tooltip and close label, the title bar, the idle screen and
     * the turn-complete notification. Distinct from the default title the
     * relay *persists* (`titleGenerator.ts`), which stays untranslated: that
     * one is written into the session record, so translating it would leave
     * every already-stored session named in the old language while new ones
     * arrived in the new one. */
    untitledSession: string;
  };
  settings: {
    title: string;
    nav: {
      /** Eyebrow over the entries that belong to the app itself, not to any
       * one profile. */
      app: string;
      profiles: string;
      appearance: string;
    };
    appearance: {
      title: string;
      scope: string;
      theme: {
        title: string;
        description: string;
        add: string;
        builtin: string;
        light: string;
        dark: string;
        /** A theme mirrored from a host this device isn't connected to: it
         * still paints, it just can't be edited or deleted from here. */
        elsewhere: string;
        options: string;
        missing: string;
        unreadable: string;
        deleteTitle: string;
        deleteBody: string;
        /** The dialog that adds, edits or duplicates one. All three are
         * the same request to the relay — only the wording differs. */
        import: {
          importTitle: string;
          importSubmit: string;
          importHint: string;
          editTitle: string;
          editHint: string;
          duplicateTitle: string;
          duplicateSubmit: string;
          duplicateHint: string;
          /** `{host}` — the machine whose registry receives the file. */
          hostHint: string;
          chooseFile: string;
          /** Appended to the name of a theme being duplicated. Only the
           * name — the id gets a fixed ASCII suffix, since an id is an
           * identifier and a translated one could carry a character the
           * validator rejects. */
          copySuffix: string;
          copied: string;
          saving: string;
          tooLarge: string;
          invalidJson: string;
          copyFailed: string;
          /** What's wrong with the file being imported, keyed by the
           * validator's own codes — which the relay reports too, so an error
           * found on the host lands in this same list in the same language.
           * `{expected}`, `{maxLength}`, `{id}` and `{missing}` carry the
           * detail the sentence needs. */
          validation: Record<ThemeValidationCode, string>;
        };
      };
      fontSize: {
        title: string;
        description: string;
        /** Sentence rendered at the chosen size, so the number means
         * something before it is committed to. */
        sample: string;
        reset: string;
      };
    };
    profile: {
      sections: {
        general: string;
        personalization: string;
      };
      home: {
        title: string;
        description: string;
        change: string;
        systemDefault: string;
        useSystemDefault: string;
      };
      model: {
        title: string;
        description: string;
        lastUsed: string;
        fixed: string;
      };
      name: {
        title: string;
        description: string;
        saving: string;
      };
      color: {
        title: string;
        description: string;
        swatch: string;
      };
      /** Only ever rendered for the profile whose relay runs on this same
       * machine, and only once it's strictly older than the app — see
       * relayDrift.ts. A relay ahead of the app (a self-hosted upgrade
       * that ran first) says nothing here on purpose. */
      relay: {
        title: string;
        /** `{relayVersion}`, `{appVersion}` */
        description: string;
        update: string;
        updating: string;
        /** The installer never restarts a service it finds already
         * running — re-running it must not be what drops an in-flight
         * conversation — so this is the one honest thing to say about
         * what a successful run just did. */
        updated: string;
        /** Homebrew owns the relay on macOS (relay_setup.rs refuses to
         * pass --version there for the same reason) — shown above the
         * literal command instead of a button that can't do anything. */
        brewHint: string;
      };
    };
    danger: {
      heading: string;
      deleteTitle: string;
      removeTitle: string;
      /** Three ways this ends up worded, because the profile itself decides
       * what deleting even means: a paired device is only ever removed
       * locally, and deleting one on a host needs another profile there to
       * run the request. */
      deleteBody: string;
      noExecutorBody: string;
      removeBody: string;
      delete: string;
      remove: string;
      confirmPrompt: string;
      deleting: string;
      /** Shown when the profile being removed is the only one: removal
       * isn't refused, it puts the first-run screen back. */
      lastProfile: string;
    };
  };
  /**
   * What the window shows instead of the shell while this device has no
   * profile: the choice of paths, the two forms, and the terminal fallback.
   * Its own surface rather than a corner of `shell` — nothing here is
   * rendered once a profile exists, and none of the shell's copy is
   * rendered before one does.
   */
  firstRun: {
    /** Drawn in the window's own title bar, which the shell's `TitleBar`
     * isn't there to provide yet. */
    windowTitle: string;
    back: string;
    /** Eyebrow beside the mark, naming where in the flow the reader is.
     * Keyed on the screen union so a new screen is a compile error until
     * it has a crumb. */
    crumbs: Record<FirstRunScreen, string>;
    home: {
      title: string;
      body: string;
      /** Path 01: the app installs the relay itself, on Linux (systemd) and
       * macOS (Homebrew) alike. */
      localTitle: string;
      localHint: string;
      /** `{container}` — the card is shown but disabled inside a Flatpak or
       * Snap, which can't reach the host's `systemd --user`. */
      localUnavailable: string;
      connectTitle: string;
      connectHint: string;
      codeTitle: string;
      codeHint: string;
      /** The line under the paths, for whoever has no relay anywhere yet. */
      terminalPrompt: string;
      terminalLink: string;
    };
    connect: {
      title: string;
      body: string;
      hostLabel: string;
      hostPlaceholder: string;
      portLabel: string;
      nameLabel: string;
      namePlaceholder: string;
      submit: string;
      /** The queue refused it — the same address is already mid-flight. */
      alreadyQueued: string;
    };
    code: {
      title: string;
      body: string;
      nameLabel: string;
      namePlaceholder: string;
      codeLabel: string;
      submit: string;
      alreadyQueued: string;
    };
    /** The terminal alternative. One body per platform because the
     * commands differ: Homebrew on macOS, WSL2 on Windows. */
    manual: {
      title: string;
      body: string;
      bodyMac: string;
      bodyWindows: string;
      install: string;
      profile: string;
      start: string;
      /** Stands in for the one value the reader has to fill in themselves,
       * printed inside angle brackets in the command. */
      relayHostPlaceholder: string;
      done: string;
    };
    copy: {
      copy: string;
      copied: string;
      failed: string;
    };
    footer: {
      nothingInstalled: string;
    };
    /** The recognition step: a look at this machine before asking anything. */
    detect: {
      title: string;
      body: string;
    };
    /** A relay with profiles was found on this machine: adopt them. */
    adopt: {
      title: string;
      /** `{count}` — registered profiles found. */
      body: string;
      /** Meta line of a profile row — `{host}`, `{port}`. */
      rowMeta: string;
      /** The `default.env` a stray relay run leaves behind. */
      orphanNote: string;
      /** `{count}` */
      adopt: string;
      adoptOne: string;
      createAnother: string;
      /** Replaces `createAnother` on macOS, where the in-app installer can
       * only ever provision one relay ("default") — points at the
       * already-connected profile switcher's "add profile" instead. */
      macNote: string;
    };
    /** Path 01: the in-app install, four steps. */
    local: {
      title: string;
      /** `{n}` of 4. */
      stepOf: string;
      notes: Record<Exclude<LocalNote, "none">, string>;
      steps: Record<LocalStep, string>;
      prereqs: {
        node: string;
        agent: string;
        systemd: string;
        /** macOS's equivalent of `node` — checked instead of it, never
         * alongside. */
        brew: string;
        checking: string;
        /** `{version}` */
        nodeMeta: string;
        loggedIn: string;
        devMode: string;
        /** The agent row's right-hand detail when the check found no CLI,
         * or one that isn't logged in — neither of which stops the
         * install. */
        agentMeta: { missing: string; loggedOut: string };
      };
      address: {
        nameLabel: string;
        namePlaceholder: string;
        nameHint: string;
        body: string;
        recommended: string;
        hints: Record<"tailnet" | "lan" | "public" | "loopback", string>;
        customLabel: string;
        customPlaceholder: string;
        loopbackWarning: string;
        submit: string;
      };
      install: {
        rows: Record<InstallRowKey, string>;
        running: string;
        failed: string;
        showRaw: string;
        hideRaw: string;
        terminal: string;
        cancel: string;
        pendingLink: string;
        /** `{count}` */
        pendingLinks: string;
        discard: string;
      };
      verify: {
        body: string;
      };
      /** One sentence per way the wizard can stop — keyed on the code so a
       * new one is a compile error until it has copy, never a raw enum on
       * screen. The installer's own detail line is shown under it. */
      /** Shown for the whole wizard, not just the step that found it: the
       * install completes without an agent CLI, and the first conversation
       * is what runs into its absence. */
      agentNotice: { missing: string; loggedOut: string };
      failures: Record<LocalFailureCode, string>;
      actions: Record<LocalFailureAction, string>;
      /** The window is being closed with an install running. */
      close: {
        title: string;
        body: string;
        background: string;
        cancel: string;
        keep: string;
      };
    };
  };
  /**
   * Failures the relay reports as a code rather than as a sentence. Typed as
   * a record over the wire contract's own unions on purpose: adding an error
   * code on the relay side and forgetting the copy is then a compile error in
   * both languages, instead of a raw enum like `not_found` reaching the user
   * — which is exactly what used to happen to four of the five folder-picker
   * failures.
   */
  errors: {
    setCwdTitle: string;
    setCwd: Record<SetCwdErrorCode, string>;
    editMessage: Record<EditMessageErrorCode, string>;
  };
  /** The conversation itself — the tab strip down to the message log.
   * Same grouping rule as `shell` below: by the surface the string appears
   * on, not by the component that renders it. */
  chat: {
    tabs: {
      newTab: string;
      close: string;
      agentWorking: string;
      sessionDone: string;
    };
    message: {
      copy: string;
      copied: string;
      /** The clipboard can refuse (no permission, no secure context) and the
       * button has no other way to say so. */
      copyFailed: string;
      /** iOS only: editing there refills the composer instead of turning the
       * bubble into a textarea, so the consequence has to be stated up front
       * — sending discards the original reply and everything after it. */
      editWarning: string;
      cancelEdit: string;
      copyResponse: string;
      edit: string;
      editUnavailable: string;
      editWithAttachment: string;
    };
    toolCall: {
      viewFile: string;
      running: string;
      usingTools: string;
      usedTools: string;
      /** Tooltip on the context-cost badge (`+13.5k`) when it was divided
       * proportionally across a parallel batch of tool calls, rather than
       * being this one call's own exact number. */
      attributionEstimatedHint: string;
    };
    code: {
      copy: string;
      copied: string;
      copyFailed: string;
      showMoreLines: string;
    };
    /** `anywh-bg` jobs the session has running: the button in the composer
     * row, the list it opens and the confirmation for killing one (or all).
     * A job is a real process on the user's machine, so every verb here is
     * about ending one, and every one of them is irreversible. */
    backgroundJobs: {
      /** `{count}` — label of the button itself when more than one is
       * running; with exactly one, the job's own label is shown instead. */
      running: string;
      /** `{count}` — the button's accessible name, which unlike the visible
       * label always states the number. */
      indicator: string;
      heading: string;
      /** Nothing has to be watched for a job to report back. */
      notice: string;
      cancel: string;
      cancelAll: string;
      /** `{label}` — the job being cancelled. */
      cancelJob: string;
      confirmAllTitle: string;
      confirmOneTitle: string;
      /** `{count}` — how many processes end at once. */
      confirmAllBody: string;
      /** `{label}` — the single job's name. */
      confirmOneBody: string;
    };
    /** The permission prompt: a tool call the CLI has paused on, waiting for
     * a yes or no. The relay sends the tool and what it would do; the words
     * are written here, and the answer travels back as an id, so translating
     * any of this can't change which verdict the relay reads. */
    approval: {
      /** `{tool}` — the tool's own name, never translated; `{detail}` — the
       * command, the path, or the raw input, which is data. */
      toolCall: string;
      /** Leaving Plan mode is a mode change, not an action, and reads
       * differently enough to deserve its own sentence. */
      exitPlanMode: string;
      approve: string;
      deny: string;
      /** `{detail}` — the command about to run, verbatim, which is data. */
      codexCommand: string;
      /** `{detail}` — the path the write would land under, which is data. */
      codexFileChange: string;
      /** Codex's own fixed decision vocabulary — a wider set than
       * approve/deny above, so each gets its own key rather than reusing
       * approve/deny for the two closest ones. */
      codexAccept: string;
      codexAcceptForSession: string;
      codexDecline: string;
      codexCancel: string;
      /** `{reason}` — Codex's own explanation for why it's asking, appended
       * to whichever question text is in play above. */
      reasonSuffix: string;
    };
    turn: {
      /** One is drawn per turn and held for its whole duration — the Claude
       * Code CLI's own behaviour, which this mirrors: a random verb instead
       * of a fixed "Thinking…", never a carousel that keeps changing while
       * you read it. The two languages don't have to be the same length,
       * and shouldn't: these are jokes, and a joke that survives a literal
       * translation is the exception. */
      workingWords: readonly string[];
      oneToolUsed: string;
      toolsUsed: string;
    };
    log: {
      loading: string;
      error: string;
      stopped: string;
      backgroundJobDone: string;
      wakeupResumed: string;
      compacted: string;
      compactedAuto: string;
      idleSubtitle: string;
    };
    choice: {
      previousQuestion: string;
      nextQuestion: string;
      questionPosition: string;
      closeAnswering: string;
      /** Aria-label for a `kind: "choice"` card's top-right button — it
       * collapses the card to the `pending`/`reopen` indicator, never
       * discards the question (see `ChoiceCard`'s `collapsed` state). */
      collapse: string;
      /** Label on the indicator that replaces a collapsed `kind: "choice"`
       * card, sitting right above the composer. */
      pending: string;
      reopen: string;
      customPlaceholder: string;
      customLabel: string;
      customAnswer: string;
      selectedCount: string;
      skip: string;
      submit: string;
    };
    /**
     * The composer and its toolbar. The two verbs on the send button aren't
     * here — `Send`/`Stop` are the same words the rest of the app uses and
     * stay in `common`.
     */
    composer: {
      placeholder: string;
      /** Drawn next to `Send`. Not translated in either language — it names
       * a physical key. It says Enter (not the design's `⌘↵`) because Enter
       * is what actually sends here: Shift+Enter breaks the line and there
       * is no modifier variant to advertise. */
      sendShortcut: string;
      attach: string;
      attachmentUploading: string;
      removeAttachment: string;
      /** Shown over the whole conversation while a file is dragged across it. */
      dropzone: string;
      /** `{reason}` — whatever the relay or the network said, which is
       * untranslated by nature. Two keys rather than one with the noun
       * substituted in: that substitution doesn't survive a language where
       * the article has to agree with it. */
      uploadFailedImage: string;
      uploadFailedVideo: string;
      /** A dropped path with no basename still has to name the File it
       * becomes — the attachment chip prints this. */
      droppedFile: string;
      /** The card that appears over a link in the composer, offering to edit
       * its target. */
      openLinkEditor: string;
      /** Editing a hyperlink created by pasting a URL over a selection. */
      editLink: {
        title: string;
        description: string;
        text: string;
        link: string;
      };
      /** Name shown on an attachment with no visual preview (a file the
       * picker accepted but can't thumbnail) — the image/video case renders
       * the thumbnail itself instead. */
      unnamedAttachment: string;
      record: string;
      stopRecording: string;
      cancelRecording: string;
      transcribing: string;
      microphone: string;
      selectMicrophone: string;
      /** Shown when the typed text reads as a mistyped command (`/cler`)
       * rather than a real one — the send waits on this answer. */
      typo: {
        question: string;
        use: string;
        sendAnyway: string;
      };
      /** Keyed by `KnownPermissionModeId`, not the wire's opaque
       * `PermissionMode` — a permission mode this build knows about missing
       * copy in either language is a compile error, same completeness
       * guarantee as before this became multi-agent. `hint` is the dropdown
       * item's second line; the model dropdown has no equivalent because its
       * catalog is whatever the CLI reports at runtime, and a blurb per
       * alias would go stale the day the CLI ships a new one. */
      mode: Record<KnownPermissionModeId, { label: string; hint: string }>;
      /** Keyed by `KnownAgentId` — same completeness guarantee as `mode`
       * above. Product names (`Claude Code`, `Codex`), identical in both
       * languages by nature, but still resolved through here rather than a
       * literal in `AgentPickerButton`. */
      agentNames: Record<KnownAgentId, string>;
      /** Both toolbar dropdowns' label before the relay has reported this
       * session's mode/model. */
      pending: string;
      modelLocked: string;
      context: {
        label: string;
        ariaLabel: string;
        /** The popover's own close button, in its header row. */
        close: string;
        tokens: string;
        /** The word between the big percentage and the token count on the
         * popover's headline row (e.g. "67% [occupied] 134k / 200k
         * tokens"). */
        occupied: string;
        /** Footer line: `{model}` and `{window}` (already formatted, e.g.
         * "200k") are the CLI's own resolved model and this session's
         * context window size. */
        windowNote: string;
        /** The popover's "Setup" line — shown only when `baselineTokens` is
         * known (absent for a record written before that field existed, or
         * a resumed session that never got a fresh baseline). `{tokens}`/
         * `{percent}` are the setup cost and its share of the window. */
        setup: string;
        breakdownRules: string;
        breakdownSkills: string;
        breakdownSubagents: string;
        /** The catch-all line for everything the baseline paid for that no
         * other category could name — never called "Other": it's usually
         * the single largest line, and "Other" would read like a rounding
         * error instead of the biggest cost this panel can't break down
         * further. */
        breakdownSystemPromptTools: string;
        breakdownEmptyDirectory: string;
        /** The remainder of the window beyond `baselineTokens` — everything
         * that happened after the conversation's first response. */
        breakdownConversation: string;
      };
      /** The three ways voice input fails. The first is a state the user can
       * fix and is written as an instruction; the other two carry whatever
       * the OS or the transcriber said, which is untranslated by nature. */
      voiceErrors: {
        microphonePermission: string;
        startFailed: string;
        transcriptionFailed: string;
      };
      /** Two of the CLI's model aliases are words rather than product names,
       * so only those two are translated — `labelForModel` prints every
       * other alias (Sonnet, Opus, `sonnet[1m]`) exactly as the CLI reports
       * it, including ones shipped after this build. */
      modelAliases: {
        default: string;
        best: string;
      };
      /** Blurbs for the autocomplete menu. A model alias the CLI ships later
       * falls back to `modelGeneric`, so it shows up in the menu without a
       * copy change — same reasoning as `labelForModel`. */
      commands: {
        clear: string;
        modelDefault: string;
        modelOpus: string;
        modelHaiku: string;
        modelGeneric: string;
      };
    };
    /** The relay this session is connected to speaks a WebSocket protocol
     * version this build doesn't match — a full takeover of the panel, not a
     * dismissible toast, since nothing sent past this point is guaranteed to
     * render correctly. */
    protocolMismatch: {
      title: string;
      message: string;
    };
  };
  /**
   * The right-side dock: the file panel, the code viewer and the terminal.
   * Grouped by surface like the rest — a string moving between the tree and
   * the viewer keeps its key, a string moving between panels doesn't.
   */
  panels: {
    /** The two buttons that open these panels. They sit in the chat's own
     * toolbar, but they name this surface, which is where the key belongs. */
    openFiles: string;
    closeFiles: string;
    openTerminal: string;
    closeTerminal: string;
    maximize: string;
    restore: string;
    close: string;
    /** Every pane tab closes the same way, files and terminals alike. */
    closeTab: string;
    files: {
      title: string;
      loading: string;
      noFileOpen: string;
      showHidden: string;
      hideHidden: string;
      /** The drag-and-drop overlay. `toFolder` names the folder row under
       * the cursor; `toRoot` covers a drop anywhere else in the panel, which
       * lands in the session's own folder. */
      drop: {
        title: string;
        toFolder: string;
        toRoot: string;
        failed: string;
      };
      viewer: {
        loading: string;
        failed: string;
        binary: string;
        truncated: string;
        viewFormatted: string;
        viewSource: string;
      };
      tree: {
        openInNewTab: string;
        openInTerminal: string;
        /** `openIn` names one detected editor; `openWith`/`openProjectWith`
         * are the submenu trigger when more than one was detected. */
        openIn: string;
        openProjectIn: string;
        openWith: string;
        openProjectWith: string;
        download: string;
        downloadMany: string;
        rename: string;
        delete: string;
        deleteMany: string;
        newFile: { title: string; description: string; placeholder: string };
        renameFile: { title: string; description: string };
        emptyFolder: string;
        listFailed: string;
        /** The two delete confirmations. Both spell out that it can't be
         * undone, because on the relay's side it genuinely can't — there is
         * no trash to recover from. */
        deleteFile: { title: string; description: string };
        deleteFiles: { title: string; description: string };
        /** Failures that reach the user through an alert. They stay generic
         * on purpose: the relay's own message for these is a stack-level
         * detail, not something to put in front of someone. */
        errors: {
          create: string;
          download: string;
          downloadFolder: string;
          /** `{failed}` of `{total}` — the folder came down, but not whole.
           * Distinct from `downloadFolder` (which is the whole thing
           * failing) because the user has files on disk either way and needs
           * to know how many are missing. */
          downloadFolderPartial: string;
          rename: string;
          delete: string;
        };
      };
      downloads: {
        fileDone: string;
        progress: string;
        done: string;
        dismiss: string;
      };
    };
    terminal: {
      newTerminal: string;
      /** Its own key rather than the title bar's: same word, different
       * surface, and the two reconnect for unrelated reasons — the relay
       * socket there, this pane's pty here. */
      reconnecting: string;
    };
  };
  /** The window frame and the session list — everything outside a
   * conversation. Grouped by the surface a string appears on rather than by
   * the component that renders it, so moving a control between surfaces
   * (the working directory, which went from the composer row to the title
   * bar) doesn't drag its key along with it. */
  shell: {
    titleBar: {
      menu: string;
      settings: string;
      back: string;
      forward: string;
      collapseSidebar: string;
      expandSidebar: string;
      openSidebar: string;
      searchSessions: string;
      checkForUpdates: string;
      minimize: string;
      maximize: string;
      restore: string;
      close: string;
      reconnecting: string;
    };
    /** The strip along the bottom of the window: what the focused session's
     * folder looks like to git, and which version of the app is running.
     * Everything here is printed in mono at 10.5px, so the copy has to stay
     * short enough to survive a narrow window without the two halves
     * colliding. */
    statusBar: {
      /** `{count}` — entries `git status` would list for the session's
       * folder, untracked files included (relay/src/gitStatus.ts). */
      changes: string;
      /** Its own key rather than a plural rule: two languages, one number
       * that is `1` often enough to be worth reading right. */
      changesOne: string;
      clean: string;
      /** Title of the branch slot when HEAD is on no branch at all — what
       * the slot then shows is a commit, and nothing else on screen says so. */
      detachedHead: string;
      /** `{version}` — title of the version slot, which has room for the
       * number but not for what the number belongs to. */
      appVersion: string;
      /** `{version}` — replaces the version slot itself once a newer
       * release exists, so there is one thing there rather than a number
       * plus a separate badge competing for the same sliver of width. */
      updateAvailable: string;
      /** `{version}` — replaces `updateAvailable` once auto-download has
       * already fetched and verified the update; nothing left to do but
       * restart into it. */
      updateReady: string;
    };
    sidebar: {
      label: string;
      newConversation: string;
      filterByProfile: string;
      filterHeading: string;
      allProfiles: string;
      loadingSessions: string;
      loadFailed: string;
      emptyTitle: string;
      emptyBody: string;
      noMatches: string;
      noMatchesHint: string;
      /** `{time}` — a relative moment ("2 hr. ago"). */
      syncedAt: string;
      neverSynced: string;
      /** The dialog the row's context-menu "rename" item opens. */
      rename: {
        title: string;
        description: string;
      };
      agentWorking: string;
      backgroundJob: string;
      /** Right-click on a session, in the list or on its tab. */
      sessionMenu: {
        rename: string;
        moveToNewGroup: string;
        delete: string;
        deleteTitle: string;
        /** `{title}` — the session about to be deleted. Says what is *not*
         * deleted too: the transcript Claude Code keeps on its own survives,
         * so "cannot be undone" would otherwise overstate it. */
        deleteBody: string;
      };
      /** The two ways a session action can fail outright. Both used to be a
       * `window.alert`, which is unreliable in these webviews. */
      renameFailed: string;
      deleteFailed: string;
      groups: {
        today: string;
        yesterday: string;
        week: string;
        older: string;
      };
    };
    profiles: {
      heading: string;
      activeProfile: string;
      addRemoteMachine: string;
      addProfile: string;
      badgeLocal: string;
      badgeRemote: string;
      badgeRevoked: string;
      /** Saved but never reached — an interrupted setup (`Profile.unverified`). */
      badgeUnverified: string;
      /** `{label}` — the switcher item that resumes that profile's setup. */
      finishSetup: string;
      /** Creating a profile on the connected host, and pairing a machine
       * that isn't reachable yet — the two ways a profile comes into
       * existence. */
      add: {
        title: string;
        description: string;
        nameLabel: string;
        namePlaceholder: string;
        homeLabel: string;
        homePlaceholder: string;
        verify: string;
        verifying: string;
        creating: string;
        /** `{path}` — the config path the command needs. */
        notLoggedIn: string;
        /** `{profile}` — the profile already using that path. */
        collides: string;
        confirmed: string;
      };
      pair: {
        title: string;
        description: string;
        nameLabel: string;
        namePlaceholder: string;
        codeLabel: string;
        codePlaceholder: string;
        /** `{origin}` — the server the code points at. */
        willPair: string;
        format: string;
        submit: string;
      };
      /** The blocking dialog that runs while a paired machine is turned
       * into a working profile. */
      setup: {
        progress: string;
        steps: {
          claim: string;
          connect: string;
          verify: string;
        };
        connectingTitle: string;
        connectedTitle: string;
        claimFailedTitle: string;
        connectFailedTitle: string;
        verifyFailedTitle: string;
        claiming: string;
        joining: string;
        dialing: string;
        verifying: string;
        /** `{count}` — conversations found on the machine. */
        ready: string;
        claimFailedBody: string;
        retryBody: string;
        /** `{label}` — the profile already pointing at that machine. */
        duplicate: string;
        useExisting: string;
        later: string;
        continueToProfile: string;
        /** `{count}` — pairings waiting behind this one. */
        queued: string;
      };
    };
    revoked: {
      eyebrow: string;
      /** `{profile}` — the profile's label, rendered as its own element. */
      body: string;
      removeProfile: string;
      dismiss: string;
      /** `{profile}` — the profile's label. */
      confirmTitle: string;
      confirmBody: string;
      /** Same note as `settings.danger.lastProfile`, in the banner's own
       * confirmation. */
      lastProfile: string;
    };
    /** The single, app-wide dialog a newer GitHub release triggers — opened
     * either from the footer's update indicator (only rendered once one is
     * available) or manually via the title bar menu's "Check for updates",
     * which always opens it regardless of outcome. Unlike `revoked` above,
     * this is never plural: a revoked connection is per-profile, but there
     * is only one running app to be behind on. */
    updateModal: {
      title: string;
      /** Shown when a manual check finds nothing newer than `APP_VERSION`. */
      upToDateTitle: string;
      /** `{version}`, `{current}` */
      body: string;
      /** `{version}` */
      upToDateBody: string;
      viewRelease: string;
      copyCommand: string;
      copied: string;
      /** The clipboard can refuse (no permission, no secure context) — said
       * on the button itself, same reasoning as `firstRun.copy.failed`. */
      copyFailed: string;
      /** Shown alongside `copyCommand`'s action — the process already
       * running keeps its old inode either way, so this is the one honest
       * thing to say about what happens next. */
      restartHint: string;
      /** `aria-label` of the on/off control at the bottom of the dialog —
       * the only place this setting lives now that Settings > Updates is
       * gone. */
      checkAutomatically: string;
      checkAutomaticallyOn: string;
      checkAutomaticallyOff: string;
      /** Third option of the same control — only rendered when
       * `InstallOrigin.updatable` is true, since it's a setting that would
       * otherwise silently do nothing. */
      checkAutomaticallyAutoDownload: string;
      /** Shown instead of `title` once auto-download has already fetched and
       * verified the update. */
      readyTitle: string;
      /** `{version}` — shown instead of `body` in the same state. */
      readyBody: string;
      restartNow: string;
    };
    /** The folder a conversation runs in. Lives in the title bar since the
     * shell redesign, but it is still per-conversation state. */
    workingDirectory: {
      chooseFolder: string;
      connecting: string;
      heading: string;
      copyPath: string;
      copyFailed: string;
      recent: string;
      noRecent: string;
      browse: string;
    };
    /** The picker itself, opened both from the composer's working-directory
     * button and from a profile's starting-folder setting. */
    folderPicker: {
      title: string;
      go: string;
      parent: string;
      empty: string;
      select: string;
      showHidden: string;
      hideHidden: string;
    };
    idle: {
      heading: string;
      subtitle: string;
    };
    search: {
      title: string;
      description: string;
      placeholder: string;
      noResults: string;
    };
  };
}
