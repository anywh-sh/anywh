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
import type { AnswerChoiceErrorCode, EditMessageErrorCode, SetCwdErrorCode } from "@/lib/relay/relay-types";

/** Every permission-mode id this build has real copy for, across every
 * agent — a closed union HERE (so `en`/`pt-br` can't drift) even though the
 * wire value (`PermissionMode`, relay-types.ts) is an opaque string: the
 * real vocabulary is per-agent and per-platform, which this dictionary
 * can't enumerate exhaustively without also knowing every def. Resolved
 * defensively at the call site instead (`PermissionModeButton`'s
 * `useModeCopy`) — an id this build doesn't know renders as itself, not a
 * compile error. Claude's four, Codex's three. */
/** Reasoning-effort ids the dictionary has a label for. The wire id is an
 * opaque string (each CLI has its own list — Codex adds `ultra`, Claude
 * `xhigh`/`max`); an id outside this set renders as itself. */
export type KnownEffortId = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type KnownPermissionModeId = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "read-only" | "workspace-write" | "full-access";

/** Every agent id this build has a display name for — resolved defensively
 * at the call site (`AgentModelEffortButton`), same id-switch-with-fallback shape
 * as `KnownPermissionModeId` above. Product names, so `en`/`pt-br` carry the
 * identical string — still dictionary entries, not a literal in the
 * component, per this repo's "any string rendered to a user lives in the
 * dictionary" rule. */
export type KnownAgentId = "claude" | "codex";
import type { ThemeValidationCode } from "@/lib/theme/theme";
import type { PreparingFailureCode } from "@/lib/install/localInstall";

/** Two tenses of one kind of call — see `Dictionary["chat"]["activity"]`. */
export interface ActivityVerb {
  past: string;
  ing: string;
}

/** Singular/plural pair; `{count}` in the plural. */
export interface ActivityCount {
  one: string;
  many: string;
}

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
    /** Accessible name of the placeholder drawn where a title is still being generated. */
    generatingTitle: string;
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
      agent: {
        title: string;
        description: string;
        lastUsed: string;
        fixed: string;
        unsupported: string;
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
    /** Connecting to a machine that is already running somewhere: a pairing
     * code or an address, with the outcome shown inline. */
    other: {
      title: string;
      body: string;
      modes: { label: string; code: string; address: string };
      code: {
        label: string;
        placeholder: string;
        empty: string;
        invalid: string;
        /** `{host}` — the machine the code names. */
        valid: string;
      };
      address: { host: string; hostPlaceholder: string; port: string; hint: string; invalid: string };
      connect: string;
      connecting: string;
      steps: { claiming: string; connecting: string; verifying: string };
      failed: { claim: string; connect: string; verify: string };
      alreadyQueued: string;
      retry: string;
      advanced: string;
    };
    /** Where the relay runs and how it gets installed. The one screen that
     * says "relay" on purpose. */
    advanced: {
      title: string;
      body: string;
      address: {
        label: string;
        loopback: string;
        lan: string;
        tailnet: string;
        custom: string;
        customPlaceholder: string;
        /** Under a typed address that isn't one. */
        invalid: string;
        default: string;
        hints: { loopback: string; lan: string; tailnet: string; custom: string };
      };
      profileName: string;
      port: string;
      /** Under the port when the app does the install: the installer picks it. */
      portHint: string;
      install: { label: string; app: string; terminal: string };
      app: { cta: string; hint: string };
      terminal: {
        /** Windows: where these commands go. */
        wsl: string;
        /** `{host}`, `{port}` */
        connectAfter: string;
        done: string;
        stepInstall: string;
        stepProfile: string;
        stepStart: string;
      };
      devMode: { label: string; hint: string };
    };
    copy: {
      copy: string;
      copied: string;
      failed: string;
    };
    /** The onboarding window's own chrome: Help, Back and the stepper. */
    frame: {
      help: string;
      back: string;
      steps: {
        label: string;
        thisMachine: string;
        otherMachine: string;
        agents: string;
      };
    };
    profile: {
      /** Label of the profile the onboarding creates on this machine. */
      defaultLabel: string;
    };
    /** The first screen on a desktop: what anywh is, and one way in. */
    welcome: {
      title: string;
      body: string;
      cta: string;
      ctaHint: string;
      otherMachine: string;
      /** The CTA is off inside a sandbox — `{container}` (flatpak, snap). */
      container: string;
      containerTerminal: string;
      /** Windows has no in-app install: anywh and the agents live in WSL2,
       * so the screen says so and lists what to have, without detecting. */
      windows: {
        notice: string;
        steps: {
          wsl: { title: string; link: string };
          agent: { title: string; link: string };
        };
        cta: string;
      };
    };
    /** The install (or the adoption of an existing one), as three steps. */
    preparing: {
      title: string;
      body: string;
      adoptTitle: string;
      adoptBody: string;
      steps: Record<"check" | "install" | "start" | "read" | "connect", string>;
      /** The quiet line under a running step. */
      sub: {
        /** `{address}` */
        waitingAt: string;
        brew: string;
        download: string;
        /** `{names}` — one profile found. */
        profilesOne: string;
        /** `{count}`, `{names}` */
        profilesMany: string;
      };
      details: string;
      cancel: string;
      resuming: string;
      reattached: string;
      failed: string;
      /** Under the card: `{profile}` is drawn between the two halves. */
      profileSummary: { before: string; after: string };
      profilesHere: string;
      fail: {
        /** Something the machine lacks, which the reader can add. */
        titleMissing: string;
        /** The install itself stopped. */
        titleStopped: string;
        keepsProgress: string;
        actions: Record<"recheck" | "retry" | "terminal" | "back" | "otherMachine", string>;
        /** One entry per code, so none reaches the screen without copy:
         * the sentence, the short red line under the failed step, and for
         * the ones fixed by hand a command to copy or a page to read. */
        codes: Record<PreparingFailureCode, { body: string; line?: string; command?: string; link?: { label: string; href: string } }>;
      };
    };
    /** "Your agents": what the relay found on the machine, one card each, and
     * the choice of which opens by default. `{where}` is `here` or `at`,
     * `{agent}` a product name, `{host}` the other machine's address. */
    agents: {
      searching: string;
      searchingBody: string;
      title: string;
      none: string;
      /** `{count}` (two or more), `{where}` */
      bodyMany: string;
      bodyOne: string;
      bodyNone: string;
      /** The relay couldn't be asked at all. */
      failed: string;
      here: string;
      at: string;
      /** The small label above the cards: the same place, capitalised. */
      scopeHere: string;
      scopeAt: string;
      recheck: string;
      state: { ready: string; noLogin: string; missing: string; checking: string };
      meta: { notOnPath: string; searching: string };
      noLoginHint: string;
      howToInstall: string;
      /** Beside `howToInstall`, when the CLI has a fuller install reference. */
      installDocs: string;
      start: string;
      startWith: string;
      switchNote: string;
      otherMachine: string;
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
    answerChoice: Record<AnswerChoiceErrorCode, string>;
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
      /** Toggle under a long message clipped at a maximum height. */
      showAll: string;
      showLess: string;
    };
    toolCall: {
      /** Tooltip on the context-cost badge (`+13.5k`) when it was divided
       * proportionally across a parallel batch of tool calls, rather than
       * being this one call's own exact number. */
      attributionEstimatedHint: string;
    };
    /** The interleaved activity flow: a turn's work as one block (`work`)
     * and what an expanded call shows. `verbs` come per kind of call in two
     * tenses (`{target}` is the file, command, pattern or query, which is
     * data); past for what finished, `ing` for what still runs. Counts have
     * a singular/plural pair per convention. */
    activity: {
      verbs: {
        read: ActivityVerb;
        edit: ActivityVerb;
        write: ActivityVerb;
        shell: ActivityVerb;
        searchFiles: ActivityVerb;
        searchContent: ActivityVerb;
        webSearch: ActivityVerb;
        webFetch: ActivityVerb;
        mcp: ActivityVerb;
        task: ActivityVerb;
        other: ActivityVerb;
      };
      /** The state mark of a row whose call failed and reported no exit code. */
      callFailed: string;
      /** A turn's work as one block: the line that heads it and the steps
       * under it. The verbs name what a step did without its target (the
       * target is a chip beside it), in the present while it runs and the
       * past once it ended. */
      work: {
        /** Heads the block while the turn runs; the clock follows it. */
        working: string;
        /** `{time}` — heads the block once the turn ended. */
        workedFor: string;
        /** The same, when no timestamps were reported. */
        worked: string;
        /** Closes a block whose turn finished (not one that was stopped). */
        done: string;
        failedOne: string;
        /** `{count}` */
        failedMany: string;
        /** `{count}` targets left out of a step's chips. */
        moreTargets: string;
        showLess: string;
        /** Opens a step's calls — arguments and results. */
        stepDetails: string;
        steps: {
          read: ActivityVerb;
          edit: ActivityVerb;
          write: ActivityVerb;
          shell: ActivityVerb;
          searchFiles: ActivityVerb;
          searchContent: ActivityVerb;
          webSearch: ActivityVerb;
          webFetch: ActivityVerb;
          mcp: ActivityVerb;
          task: ActivityVerb;
          other: ActivityVerb;
        };
      };
      /** What the expanded call's input line is labelled with. */
      inputLabels: { path: string; pattern: string; regex: string; query: string; url: string; mcp: string };
      meta: {
        lines: ActivityCount;
        files: ActivityCount;
        matches: ActivityCount;
        results: ActivityCount;
        exit: string;
      };
      /** The labelled, copyable blocks of an expanded call. */
      block: {
        arguments: string;
        result: string;
        copyArguments: string;
        /** Past this height a block is clipped behind this toggle. */
        showAll: string;
        showLess: string;
        /** `{count}` characters left out of the display of a huge payload. */
        truncated: string;
      };
      copyResult: string;
      resultCopied: string;
      showAll: string;
      openFile: string;
      running: string;
      noOutput: string;
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
    /** Inline cards above the streaming indicator, for background work
     * launched from THIS conversation — an `anywh-bg` process (real data:
     * label, elapsed time), or a `Task` subagent call still in flight (the
     * only real signal for that: the protocol carries no step/progress,
     * model or token data for a subagent's own work, so unlike the `proc`
     * card there is nothing to show once expanded besides the stop action).
     * Replaces `backgroundJobs` above on desktop — a single tray inside the
     * conversation instead of a separate chip next to the composer. */
    launchedInBackground: {
      /** Section label above the cards, uppercase via CSS. */
      heading: string;
      /** Badge on a subagent card. */
      agentBadge: string;
      /** Badge on a process card. */
      procBadge: string;
      /** Fallback name for a subagent card when the `Task` call carries no
       * `description` input. */
      agentFallbackName: string;
      /** Expanded process card action: cancels the `anywh-bg` job. */
      stopProcess: string;
      /** Expanded subagent card action: stops the WHOLE turn — there is no
       * way to stop just the one subagent call, since it has no process of
       * its own the way an `anywh-bg` job does. */
      stopAgent: string;
      /** Expanded process card, before the first log read comes back. */
      logLoading: string;
      /** Expanded process card whose job hasn't printed anything yet. */
      logEmpty: string;
      /** Expanded process card when the relay can't serve the job's log
       * (one predating the log route, or unreachable). */
      logUnavailable: string;
      /** Expanded subagent card before the subagent has called any tool. */
      agentNoToolCalls: string;
      /** Running subagent card meta, after its elapsed time: how many tools
       * it has used so far — singular, then `{count}` plural. */
      agentOneToolUse: string;
      agentToolUses: string;
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
    log: {
      loading: string;
      error: string;
      stopped: string;
      backgroundJobDone: string;
      wakeupResumed: string;
      /** A report or instruction from the room, drawn as a card. */
      roomCard: {
        done: string;
        failed: string;
        needsYou: string;
        open: string;
        reply: string;
        /** `{status}`, `{time}`. */
        label: string;
        /** `{title}`. */
        openAria: string;
        /** `{title}`. */
        replyAria: string;
        /** `{title}`. */
        instructionAria: string;
        /** `{time}`: a compact span like "12m". */
        ago: string;
        untitledAgent: string;
      };
      compacted: string;
      compactedAuto: string;
      idleSubtitle: string;
      /** The heading of a new session, above the composer. */
      idleTitle: string;
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
      /** The desktop field's prompt — the iOS native composer keeps `placeholder`. */
      placeholderTask: string;
      /** Shown instead of `placeholderTask` while a turn runs: a message sent now waits its turn. */
      placeholderQueue: string;
      /** The native (iOS) composer's attach menu, which only takes images
       * and video there. */
      attach: string;
      /** The web composer's attach button, which takes any supported file. */
      attachAnyFile: string;
      attachmentUploading: string;
      /** Tooltip and label of the send button while an attachment uploads. */
      sendWaitingForUpload: string;
      removeAttachment: string;
      /** iOS attach menu: the photo library and the Files app. */
      attachPhotos: string;
      attachFiles: string;
      /** iOS: the round button that jumps back to the end of a conversation
       * the user has scrolled away from. */
      scrollToEnd: string;
      /** Shown over the whole conversation while a file is dragged across it. */
      dropzone: string;
      /** `{reason}` — whatever the relay or the network said, which is
       * untranslated by nature. Two keys rather than one with the noun
       * substituted in: that substitution doesn't survive a language where
       * the article has to agree with it. */
      uploadFailedImage: string;
      uploadFailedVideo: string;
      uploadFailedFile: string;
      /** A file the composer refuses by its extension; `{names}` is the
       * comma-separated list of the refused files' names. */
      unsupportedAttachment: string;
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
       * literal in `AgentModelEffortButton`. */
      agentNames: Record<KnownAgentId, string>;
      /** Both toolbar dropdowns' label before the relay has reported this
       * session's mode/model. */
      pending: string;
      modelLocked: string;
      /** Keyed by `KnownEffortId`; an id the CLI lists that isn't here is shown raw. */
      effortLabels: Record<KnownEffortId, string>;
      /** The effort dropdown's entry meaning "no explicit pick" (offered only
       * for a model whose CLI reports no default effort of its own). */
      effortDefault: string;
      effortAriaLabel: string;
      /** Tooltip and accessible name of the single agent/model/effort trigger. */
      agentMenuLabel: string;
      menu: {
        agent: string;
        model: string;
        effort: string;
        thisSession: string;
        newSession: string;
        fixedInSession: string;
      };
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
      /** The four ways voice input fails. The first two are states the user
       * can fix and are written as instructions; the other two carry
       * whatever the OS or the transcriber said, which is untranslated by
       * nature. */
      voiceErrors: {
        noMicrophone: string;
        microphonePermission: string;
        startFailed: string;
        transcriptionFailed: string;
      };
      /** Blurbs for the autocomplete menu. Each model entry's blurb is the
       * agent CLI's own display name and description (`slashCommands.ts`),
       * so only the two non-model commands need copy here. */
      commands: {
        clear: string;
        modelDefault: string;
        effortDefault: string;
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
    showRightPanel: string;
    hideRightPanel: string;
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
      /** Row of the iOS top bar dropdown that opens the model list. */
      model: string;
      /** Row of the same dropdown that opens the permission-mode list. */
      mode: string;
      /** Row of the same dropdown that opens the reasoning-effort list. */
      effort: string;
      menu: string;
      settings: string;
      collapseSidebar: string;
      expandSidebar: string;
      openSidebar: string;
      checkForUpdates: string;
      minimize: string;
      maximize: string;
      restore: string;
      close: string;
      reconnecting: string;
      /** Accessibility label of the connection dot while the session is connected. */
      connected: string;
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
      relayConnected: string;
      /** `{version}` — replaces the version slot itself once a newer
       * release exists, so there is one thing there rather than a number
       * plus a separate badge competing for the same sliver of width. */
      updateAvailable: string;
      /** `{version}` — replaces `updateAvailable` once auto-download has
       * already fetched and verified the update; nothing left to do but
       * restart into it. */
      updateReady: string;
      /** The chip that opens the cross-session background-activity tray —
       * first item on the left, before the git status. Unlike
       * `backgroundJobs` below (a single session's own `anywh-bg` jobs, shown
       * next to the composer), this aggregates every open tab: another tab
       * mid-turn ("agent") and every `anywh-bg` job ("proc"), running or
       * failed. */
      backgroundActivity: {
        /** Tooltip on the chip itself. */
        chipTitle: string;
        /** `{count}` — the chip's own summary text when at least one thing
         * is running or queued. */
        running: string;
        /** The chip's summary text with nothing running or queued. */
        none: string;
        /** `{count}` — appended after `running`/`none` with " · " between
         * them, only when at least one item failed. */
        failedSuffix: string;
        /** Rooms' agents waiting for the person; takes `{count}`. */
        needYou: string;
        /** Panel header label, the dropdown's own label row. */
        heading: string;
        /** Empty-state title, once every job is gone or dismissed. */
        emptyTitle: string;
        /** Row action: jumps to the item's tab and closes the panel. */
        open: string;
        /** Row action on a running item: cancels the `anywh-bg` job, or
         * stops the other tab's turn. */
        stop: string;
        /** Row action on a failed item: drops it from the list. There is no
         * "retry" action — the relay never recorded the original command, so
         * there is nothing to re-run. */
        dismiss: string;
        /** Footer button, stops every running/queued item at once. */
        stopAll: string;
        /** Badge on an item whose `kind` is `"agent"` — another tab with a
         * turn in flight right now. */
        agentBadge: string;
        /** Badge on an item whose `kind` is `"proc"` — an `anywh-bg` job. */
        procBadge: string;
        /** Tail line for an `"agent"` item — there is no per-tab activity
         * text to show here (that lives inside that tab's own
         * `TurnIndicator`), just the fact that a turn is running. */
        agentTail: string;
        /** `{time}` — a failed item's row, how long ago it finished. */
        timeAgo: string;
        /** A running process row's log line before the first read answers. */
        logLoading: string;
        /** A running process row's log line when the relay can't serve the
         * log (one predating the log route, or unreachable). */
        logUnavailable: string;
        /** A process row whose job hasn't printed anything. */
        noOutput: string;
      };
    };
    sidebar: {
      label: string;
      newConversation: string;
      search: string;
      allChats: string;
      allProfiles: string;
      loadingSessions: string;
      loadFailed: string;
      emptyTitle: string;
      emptyBody: string;
      noMatches: string;
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
      /** Headings of the desktop sidebar list: what waits for the person,
       * what runs, then the latest sessions. */
      needsYou: string;
      running: string;
      completed: string;
      recent: string;
      /** "clear" beside the Completed heading, its tooltip, the "new" meta of
       * a row not yet looked at, the row's label, and the link to search. */
      clearCompleted: string;
      clearCompletedTitle: string;
      olderInSearch: string;
      /** A room row's tooltips; each takes `{count}`. */
      roomNeedsYou: string;
      roomWorking: string;
      roomFailed: string;
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
      allProfilesToggle: string;
      scopeAll: string;
      scopeActive: string;
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
        /** `{path}` — the config path the command needs; `{agent}` — the
         * CLI that owns the login, since which one it is now depends on
         * the agent picked above. */
        notLoggedIn: string;
        /** `{profile}` — the profile already using that path. */
        collides: string;
        confirmed: string;
        /** Which agent CLI this profile is for — decides what the login
         * check asks, and whose configuration the copy offer reads. */
        runtimeLabel: string;
        /** The offer itself, shown only when the host actually has
         * something configured for the chosen agent. */
        copyLabel: string;
        /** `{files}`, `{servers}` — what the copy would carry. */
        copySummary: string;
        /** Explains that servers come across declared, not signed in. */
        copyServersNote: string;
        /** `{count}` — settings naming a path that may not exist where
         * this lands (a hook, an MCP command). */
        copyWarnings: string;
        /** Shown while the configuration is written, before the dialog
         * closes — the profile must not be usable before its setup is in
         * place. */
        applying: string;
        /** `{error}` — the profile exists, but its configuration didn't
         * make it; nothing is lost, the copy can be retried by hand. */
        applyFailed: string;
      };
      /** Signing in to the MCP servers a carried setup brought along —
       * they travel declared, never authenticated. */
      mcpSignIn: {
        title: string;
        description: string;
        signIn: string;
        working: string;
        signedIn: string;
        failed: string;
        /** The field where the redirect URL from the browser goes back. */
        pastePlaceholder: string;
        send: string;
        done: string;
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
    /** Plan usage (Claude Code / Codex subscription windows): the status
     * bar's indicator and its details card. `{window}` is a window's label
     * ("5h", "7d"), `{percent}`/`{expected}` whole numbers, `{duration}` a
     * compact span ("58m", "1h 12m") and `{when}` a weekday + time. */
    usage: {
      /** A read is in progress for this agent (the relay's `reading`). */
      reading: string;
      /** The last read failed, by cause. `readError` is the one with no
       * known cause. */
      errorNetwork: string;
      errorAuth: string;
      errorParse: string;
      /** The active profile's relay predates plan usage: the indicator
       * says so instead of disappearing, so an old relay reads as one. */
      outdated: string;
      /** Its phrase in the indicator's accessible name. */
      outdatedSummary: string;
      /** The details card (`UsageCard`). */
      card: {
        /** Accessible name of a Copy button: "Copy codex login". */
        copyCommand: string;
        /** When the refresh button can read again: "again in 48s". Shown
         * next to the reading's age while every relay would answer from its
         * cache. */
        againIn: string;
        /** An agent installed but never logged in on this profile (relay's
         * `everSignedIn: false`). Provisional copy: no design sign-off yet. */
        notUsed: string;
        title: string;
        /** `{count}` profiles in the card's header, plural and singular. */
        profiles: string;
        profilesOne: string;
        /** `{count}` accounts shown in full. */
        accounts: string;
        accountsOne: string;
        refresh: string;
        /** Tag on the group of the active tab's profile. */
        activeTab: string;
        connecting: string;
        /** A profile whose relay is unreachable, nothing cached. */
        offline: string;
        /** Same, with its last numbers shown: "offline · 12m ago". `{ago}`
         * is `updatedAgo`. */
        staleSince: string;
        unsupported: string;
        noAgents: string;
        /** Repeated account: "same account as {profile}" — `{profile}` is
         * drawn as the profile's square and name. */
        sameAccount: string;
        signedOut: string;
        /** The last read failed; the rows are the reading before it. */
        readErrorKept: string;
        /** Card line of an agent never read: the refresh button reads it. */
        notReadHint: string;
        /** Spoken renewal of a window: "renews in 1h 12m". */
        renewsIn: string;
        /** "renews Fri 14:00". */
        renewsOn: string;
        /** Legend of the 1px mark on every bar. */
        paceLegend: string;
      };
      /** The status bar indicator's accessible name: "Usage: {items}". The
       * items are the phrases below, joined with "; ". */
      summary: string;
      /** One agent's reading in that summary: "Claude Code 58% 5h". */
      summaryWindow: string;
      /** One spent agent: "Claude Code limit reached, back in 58m". `{reset}`
       * is `resetsIn`/`resetsOn`, or empty when the reset time is unknown. */
      summaryLimited: string;
      /** `{agent}` + one of the state words below: "Codex not signed in". */
      summaryState: string;
      /** A window at 100%, with no reset time to say instead. */
      limited: string;
      /** The CLI is installed but has no login. */
      signedOut: string;
      /** Logged in with an API key or another non-plan login: no windows. */
      apiKey: string;
      /** Nothing read yet, and no read in progress. */
      noData: string;
      /** The last read failed and there is no earlier one to show. */
      readError: string;
      /** The active profile's relay is unreachable and these are its last
       * numbers: "offline, last read 12m ago". `{ago}` is `updatedAgo`. */
      stale: string;
      /** Accessible name of a usage meter: "5h: 58% used". */
      meterLabel: string;
      /** Spoken value of a meter whose window has an expected pace — the
       * pace mark itself is hidden from assistive tech, this carries it. */
      meterValueWithPace: string;
      /** Spoken value of a meter with no pace (spent window, unknown reset). */
      meterValue: string;
      /** A spent window coming back within a day: "back in 58m". */
      resetsIn: string;
      /** A spent window coming back later than a day from now: "back Fri 14:00". */
      resetsOn: string;
      /** When the numbers were read: "12s ago". */
      updatedAgo: string;
      /** Same, within the last second (the refresh button's "now"). */
      updatedNow: string;
    };
  };
  /** The room: an agent orchestration canvas, a session type chosen on the new
   * session screen. */
  sala: {
    /** The new-session selector between a conversation and a room. */
    newSession: {
      modeLabel: string;
      conversation: string;
      room: string;
      placeholderRoom: string;
      createFailed: string;
    };
    /** Accessible name of the room glyph in the session list and tab strip. */
    roomGlyph: string;
    /** The room's principal agent, by a fixed name: its card, its panel and who delegated a worker. */
    orchestrator: string;
    /** The room's tab and its canvas. */
    canvas: {
      label: string;
      loading: string;
      gone: string;
      reconnecting: string;
      empty: string;
    };
    card: {
      /** `{title}`, `{status}`. */
      aria: string;
      untitled: string;
      reply: string;
      status: {
        running: string;
        starting: string;
        yourTurn: string;
        done: string;
        stopped: string;
        idle: string;
        failed: string;
        blocked: string;
      };
      activity: {
        coordinating: string;
        coordinatingOne: string;
        working: string;
        /** `{count}` native subtasks running. */
        workingSubtasks: string;
        needsApproval: string;
        needsAnswer: string;
        queued: string;
        idle: string;
        stopped: string;
        noReport: string;
        /** Reasoning, while it goes on and once it is over. */
        thinking: string;
        thought: string;
      };
      /** The line under the card; each takes `{time}` (`m:ss`) except
       * `starting`. */
      clock: {
        running: string;
        waiting: string;
        done: string;
        failed: string;
        blocked: string;
        stopped: string;
        starting: string;
        /** Same, when the relay knows how long the agent ran. */
        doneTook: string;
        failedTook: string;
        blockedTook: string;
      };
      /** The bar over a selected card. */
      actions: {
        label: string;
        open: string;
        delegate: string;
        group: string;
        stop: string;
        remove: string;
      };
    };
    area: {
      nameLabel: string;
      namePlaceholder: string;
      /** `{count}` agents. */
      agents: string;
      agentsOne: string;
      /** `{count}` of its agents working. */
      running: string;
      /** `{count}` of its agents waiting for the person. */
      waiting: string;
      waitingMany: string;
      remove: string;
    };
    text: {
      label: string;
      placeholder: string;
    };
    toolbar: {
      label: string;
      select: string;
      hand: string;
      newAgent: string;
      newAgentSoon: string;
      attach: string;
      text: string;
      area: string;
      zoomOut: string;
      zoomIn: string;
      /** `{percent}`. */
      zoomReset: string;
      fit: string;
      /** Tooltip words around a shortcut. */
      orHold: string;
      space: string;
    };
    /** The right-hand panel: about the room, one agent, the principal's chat. */
    panel: {
      close: string;
      /** The handle on the panel's left edge that resizes it. */
      resize: string;
      /** The "i" button over the canvas. */
      about: string;
      aboutRoom: {
        /** `{count}` agents. */
        subtitle: string;
        statAgents: string;
        statRunning: string;
        statWaiting: string;
        statDone: string;
        where: string;
        folder: string;
        profile: string;
        usage: string;
        /** What the numbers are, and what they are not. */
        usageNote: string;
        usageEmpty: string;
        /** `{count}` tokens. */
        tokens: string;
        connectors: string;
        connectorsEmpty: string;
        context: string;
        contextBody: string;
        contextEmpty: string;
        worktrees: string;
        worktreesEmpty: string;
        /** `{size}`. */
        worktreesTotal: string;
        completedTitle: string;
        /** `{count}` worktrees kept. */
        completedKept: string;
        completedKeptOne: string;
        completedClean: string;
      };
      agent: {
        /** `{runtime}`, `{model}`. */
        subtitle: string;
        /** `{tokens}` in the agent's context, `{percent}` of its window. */
        contextUsed: string;
        /** Same, before the window is known: `{tokens}`. */
        contextUsedNoWindow: string;
        /** `{title}`. */
        delegatedBy: string;
        /** `{count}` commits. */
        commits: string;
        commitsOne: string;
        integrated: string;
        notIntegrated: string;
        /** `{size}`. */
        worktreeSize: string;
        /** The worktree beside "Delegated by", for assistive tech: `{branch}`. */
        worktree: string;
        connectors: string;
        subtasks: string;
        subtaskStop: string;
        activity: string;
        failedTitle: string;
        failedBody: string;
        stoppedTitle: string;
        removedWork: string;
        permission: string;
        messagePlaceholder: string;
        send: string;
        sendFailed: string;
        openInTab: string;
        delegate: string;
        stop: string;
        resume: string;
        remove: string;
      };
    };
    /** The launcher over the toolbar. */
    launcher: {
      label: string;
      placeholder: string;
      /** `{title}`. */
      delegatedBy: string;
      pickParent: string;
      agentLabel: string;
      send: string;
      /** `{count}` items. */
      inherits: string;
      escape: string;
      failed: string;
      full: string;
    };
    /** The answer popover anchored to a card. */
    answer: {
      label: string;
      openConversation: string;
      connecting: string;
    };
    /** A room whose agents all finished. */
    completed: {
      title: string;
      /** `{count}`. */
      kept: string;
      keptOne: string;
      review: string;
    };
    /** The bar over the room while several agents are selected. */
    multi: {
      label: string;
      /** `{count}`. */
      count: string;
      /** `{shift}` and `{mod}`: the platform's Shift and command keys (⇧ and ⌘ on macOS, Shift and Ctrl elsewhere). */
      hint: string;
      group: string;
      stop: string;
      remove: string;
      clear: string;
    };
    /** What the room asks before an action that cannot simply be taken back. */
    confirm: {
      cancel: string;
      /** `{title}`. */
      removeOneTitle: string;
      /** `{count}`. */
      removeManyTitle: string;
      /** `{along}`: one of the `along*` below, or nothing. */
      removeOneBody: string;
      removeManyBody: string;
      /** The agents the removed one delegated to, which leave with it. */
      alongOne: string;
      /** `{count}`. */
      alongMany: string;
      /** Same, when several agents are removed. */
      alongOneOfMany: string;
      /** `{count}`. */
      alongManyOfMany: string;
      remove: string;
      /** Beside the buttons when some of the agents have work nobody integrated: `{branches}`. */
      discardNote: string;
      /** While the room checks for that work. */
      checking: string;
      /** Appended when that check failed. */
      checkFailed: string;
      groupTitle: string;
      /** `{count}` agents; the areas' names follow. */
      groupBodyOne: string;
      groupBodyMany: string;
      group: string;
    };
    minimap: string;
    toast: {
      backTo100: string;
      removed: string;
      removedSub: string;
      /** `{count}`. */
      removedMany: string;
      removedManySub: string;
      stoppedOne: string;
      /** `{count}`. */
      stoppedMany: string;
      stoppedManySub: string;
      /** `{count}`. */
      grouped: string;
      undo: string;
      stopFailed: string;
      removeFailed: string;
      restoreFailed: string;
      attached: string;
      attachFailed: string;
      saveFailed: string;
    };
  };
}
