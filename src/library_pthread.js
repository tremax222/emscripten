var LibraryPThread = {
  $PThread__postset: 'if (!ENVIRONMENT_IS_PTHREAD) PThread.initMainThreadBlock();',
  $PThread: {
    MAIN_THREAD_ID: 1, // A special constant that identifies the main JS thread ID.
    mainThreadInfo: {
      schedPolicy: 0/*SCHED_OTHER*/,
      schedPrio: 0
    },
    thisThreadCancelState: 0, // 0: PTHREAD_CANCEL_ENABLE is the default for all threads. (1: PTHREAD_CANCEL_DISABLE is the other option)
    thisThreadCancelType: 0, // 0: PTHREAD_CANCEL_DEFERRED is the default for all threads. (1: PTHREAD_CANCEL_ASYNCHRONOUS is the other option)
    // Since creating a new Web Worker is so heavy (it must reload the whole compiled script page!), maintain a pool of such
    // workers that have already parsed and loaded the scripts.
    unusedWorkerPool: [],
    // The currently executing pthreads.
    runningWorkers: [],
    // Points to a pthread_t structure in the Emscripten main heap, allocated on demand if/when first needed.
    // mainThreadBlock: undefined,
    initMainThreadBlock: function() {
      if (ENVIRONMENT_IS_PTHREAD) return undefined;
      PThread.mainThreadBlock = allocate({{{ C_STRUCTS.pthread.__size__ }}}, "i32*", ALLOC_STATIC);
      for(var i = 0; i < {{{ C_STRUCTS.pthread.__size__ }}}/4; ++i) HEAPU32[PThread.mainThreadBlock/4+i] = 0;

      // Allocate memory for thread-local storage.
      var tlsMemory = allocate({{{ cDefine('PTHREAD_KEYS_MAX') }}} * 4, "i32*", ALLOC_STATIC);
      for(var i = 0; i < {{{ cDefine('PTHREAD_KEYS_MAX') }}}; ++i) HEAPU32[tlsMemory/4+i] = 0;
      Atomics.store(HEAPU32, (PThread.mainThreadBlock + {{{ C_STRUCTS.pthread.tsd }}} ) >> 2, tlsMemory); // Init thread-local-storage memory array.
      Atomics.store(HEAPU32, (PThread.mainThreadBlock + {{{ C_STRUCTS.pthread.tid }}} ) >> 2, PThread.mainThreadBlock); // Main thread ID.
      Atomics.store(HEAPU32, (PThread.mainThreadBlock + {{{ C_STRUCTS.pthread.pid }}} ) >> 2, PROCINFO.pid); // Process ID.
    },
    // Maps pthread_t to pthread info objects
    pthreads: {},
    pthreadIdCounter: 2, // 0: invalid thread, 1: main JS UI thread, 2+: IDs for pthreads

    exitHandlers: null, // An array of C functions to run when this thread exits.

    runExitHandlers: function() {
      if (PThread.exitHandlers !== null) {
        while (PThread.exitHandlers.length > 0) {
          PThread.exitHandlers.pop()();
        }
        PThread.exitHandlers = null;
      }

      // Call into the musl function that runs destructors of all thread-specific data.
      if (ENVIRONMENT_IS_PTHREAD && threadBlock) ___pthread_tsd_run_dtors();
    },

    // Called when we are performing a pthread_exit(), either explicitly called by programmer,
    // or implicitly when leaving the thread main function.
    threadExit: function(exitCode) {
      PThread.runExitHandlers();
      // No-op in the main thread. Note: Spec says we should join() all child threads, but since we don't have join,
      // we might at least cancel all threads.
      if (!ENVIRONMENT_IS_PTHREAD) return 0;

      if (threadBlock) { // If we haven't yet exited?
        Atomics.store(HEAPU32, (threadBlock + {{{ C_STRUCTS.pthread.threadExitCode }}} ) >> 2, exitCode);
        // When we publish this, the main thread is free to deallocate the thread object and we are done.
        // Therefore set threadBlock = 0; above to 'release' the object in this worker thread.
        Atomics.store(HEAPU32, (threadBlock + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2, 1);
        threadBlock = 0;
        postMessage({ cmd: 'exit' });
      }
    },

    threadCancel: function() {
      PThread.runExitHandlers();
      Atomics.store(HEAPU32, (threadBlock + {{{ C_STRUCTS.pthread.threadExitCode }}} ) >> 2, -1/*PTHREAD_CANCELED*/);
      threadBlock = selfThreadId = 0; // Not hosting a pthread anymore in this worker, reset the info structures to null.
      postMessage({ cmd: 'cancelDone' });
    },

    freeThreadData: function(pthread) {
      if (pthread.threadBlock) {
        var tlsMemory = {{{ makeGetValue('pthread.threadBlock', C_STRUCTS.pthread.tsd, 'i32') }}};
        {{{ makeSetValue('pthread.threadBlock', C_STRUCTS.pthread.tsd, 0, 'i32') }}};
        _free(pthread.tlsMemory);
        _free(pthread.threadBlock);
      }
      pthread.threadBlock = 0;
      if (pthread.allocatedOwnStack && pthread.stackBase) _free(pthread.stackBase);
      pthread.stackBase = 0;
      if (pthread.worker) pthread.worker.pthread = null;
    },

    // Allocates a the given amount of new web workers and stores them in the pool of unused workers.
    // onFinishedLoading: A callback function that will be called once all of the workers have been initialized and are
    //                    ready to host pthreads. Optional. This is used to mitigate bug https://bugzilla.mozilla.org/show_bug.cgi?id=1049079
    allocateUnusedWorkers: function(numWorkers, onFinishedLoading) {
      Module['print']('Preallocating ' + numWorkers + ' workers for a pthread spawn pool.');
      // Create a new one.
      // To spawn a web worker, we must give it a URL of the file to run. This means that for now, the new pthread we are spawning will
      // load the same Emscripten-compiled output .js file as the thread starts up.
      var url = window.location.pathname;
      url = url.substr(url.lastIndexOf('/')+1).replace('.html', '.js');

      var numWorkersLoaded = 0;
      for(var i = 0; i < numWorkers; ++i) {
        var worker = new Worker('pthread-main.js');

        worker.onmessage = function(e) {
          if (e.data.cmd == 'spawnThread') {
            __spawn_thread(e.data);
          } else if (e.data.cmd == 'cleanupThread') {
            __cleanup_thread(e.data.thread);
          } else if (e.data.cmd == 'killThread') {
            __kill_thread(e.data.thread);
          } else if (e.data.cmd == 'cancelThread') {
            __cancel_thread(e.data.thread);
          } else if (e.data.cmd == 'loaded') {
            ++numWorkersLoaded;
            if (numWorkersLoaded == numWorkers && onFinishedLoading) {
              onFinishedLoading();
            }
          } else if (e.data.cmd == 'print') {
            Module['print']('Thread ' + e.data.threadId + ': ' + e.data.text);
          } else if (e.data.cmd == 'printErr') {
            Module['printErr']('Thread ' + e.data.threadId + ': ' + e.data.text);
          } else if (e.data.cmd == 'exit') {
            // todo 
          } else if (e.data.cmd == 'cancelDone') {
              PThread.freeThreadData(worker.pthread);
              worker.pthread = undefined; // Detach the worker from the pthread object, and return it to the worker pool as an unused worker.
              PThread.unusedWorkerPool.push(worker);
              // TODO: Free if detached.
              PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker.pthread), 1); // Not a running Worker anymore.
          } else {
            Module['printErr']("worker sent an unknown command " + e.data.cmd);
          }
        };

        worker.onerror = function(e) {
          Module['printErr']('pthread sent an error! ' + e.message);
        };

        // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
        worker.postMessage({ cmd: 'load', url: url, buffer: HEAPU8.buffer }, [HEAPU8.buffer]);
        PThread.unusedWorkerPool.push(worker);
      }
    },

    getNewWorker: function() {
      if (PThread.unusedWorkerPool.length == 0) PThread.allocateUnusedWorkers(1);
      if (PThread.unusedWorkerPool.length > 0) return PThread.unusedWorkerPool.pop();
      else return null;
    },

    busySpinWait: function(msecs) {
      var t = performance.now() + msecs;
      while(performance.now() < t)
        ;
    }
  },

  _kill_thread: function(pthread_ptr) {
    if (ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! _kill_thread() can only ever be called from main JS thread!';
    if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in _kill_thread!';
    {{{ makeSetValue('pthread_ptr', C_STRUCTS.pthread.self, 0, 'i32') }}};
    var pthread = PThread.pthreads[pthread_ptr];
    pthread.worker.terminate();
    PThread.freeThreadData(pthread);
    // The worker was completely nuked (not just the pthread execution it was hosting), so remove it from running workers
    // but don't put it back to the pool.
    PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(pthread.worker.pthread), 1); // Not a running Worker anymore.
    pthread.worker.pthread = undefined;
  },

  _cleanup_thread: function(pthread_ptr) {
    if (ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! _cleanup_thread() can only ever be called from main JS thread!';
    if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in _cleanup_thread!';
    {{{ makeSetValue('pthread_ptr', C_STRUCTS.pthread.self, 0, 'i32') }}};
    var pthread = PThread.pthreads[pthread_ptr];
    var worker = pthread.worker;
    PThread.freeThreadData(pthread);
    worker.pthread = undefined; // Detach the worker from the pthread object, and return it to the worker pool as an unused worker.
    PThread.unusedWorkerPool.push(worker);
    PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker.pthread), 1); // Not a running Worker anymore.
  },

  _cancel_thread: function(pthread_ptr) {
    if (ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! _cancel_thread() can only ever be called from main JS thread!';
    if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in _cancel_thread!';
    var pthread = PThread.pthreads[pthread_ptr];
    pthread.worker.postMessage({ cmd: 'cancel' });
  },

  _spawn_thread: function(threadParams) {
    if (ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! _spawn_thread() can only ever be called from main JS thread!';

    var worker = PThread.getNewWorker();
    if (worker.pthread !== undefined) throw 'Internal error!';
    if (!threadParams.pthread_ptr) throw 'Internal error, no pthread ptr!';
    PThread.runningWorkers.push(worker);

    // Allocate memory for thread-local storage and initialize it to zero.
    var tlsMemory = _malloc({{{ cDefine('PTHREAD_KEYS_MAX') }}} * 4);
    for(var i = 0; i < {{{ cDefine('PTHREAD_KEYS_MAX') }}}; ++i) {
      {{{ makeSetValue('tlsMemory', 'i*4', 0, 'i32') }}};
    }

    var pthread = PThread.pthreads[threadParams.pthread_ptr] = { // Create a pthread info object to represent this thread.
      worker: worker,
      stackBase: threadParams.stackBase,
      stackSize: threadParams.stackSize,
      allocatedOwnStack: threadParams.allocatedOwnStack,
      thread: threadParams.pthread_ptr,
      threadBlock: threadParams.pthread_ptr // Info area for this thread in Emscripten HEAP (shared)
    };
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2, 0); // threadStatus <- 0, meaning not yet exited.
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.threadExitCode }}} ) >> 2, 0); // threadExitCode <- 0.
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.detached }}} ) >> 2, threadParams.detached);
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.tsd }}} ) >> 2, tlsMemory); // Init thread-local-storage memory array.
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.tsd_used }}} ) >> 2, 0); // Mark initial status to unused.
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.tid }}} ) >> 2, pthread.threadBlock); // Main thread ID.
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.pid }}} ) >> 2, PROCINFO.pid); // Process ID.

    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.attr }}}) >> 2, threadParams.stackSize);
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.attr }}} + 8) >> 2, threadParams.stackBase);
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.attr }}} + 12) >> 2, threadParams.detached);
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.attr }}} + 20) >> 2, threadParams.schedPolicy);
    Atomics.store(HEAPU32, (pthread.threadBlock + {{{ C_STRUCTS.pthread.attr }}} + 24) >> 2, threadParams.schedPrio);

    worker.pthread = pthread;

    // Ask the worker to start executing its pthread entry point function.
    worker.postMessage({
      cmd: 'run',
      start_routine: threadParams.startRoutine,
      arg: threadParams.arg,
      threadBlock: threadParams.pthread_ptr,
      selfThreadId: threadParams.pthread_ptr, // TODO: Remove this since thread ID is now the same as the thread address.
      stackBase: threadParams.stackBase,
      stackSize: threadParams.stackSize,
      stdin: _stdin,
      stdout: _stdout,
      stderr: _stderr
    });
  },

  pthread_create__deps: ['_spawn_thread', 'pthread_getschedparam', 'pthread_self'],
  pthread_create: function(pthread_ptr, attr, start_routine, arg) {
    if (!HEAPU8.buffer instanceof SharedArrayBuffer) {
      Module['printErr']('Current environment does not support SharedArrayBuffer, pthreads are not available!');
      return 1;
    }
    if (!pthread_ptr) {
      Module['printErr']('pthread_create called with a null thread pointer!');
      return 1;
    }
    var stackSize = 0;
    var stackBase = 0;
    var detached = 0; // Default thread attr is PTHREAD_CREATE_JOINABLE, i.e. start as not detached.
    var schedPolicy = 0; /*SCHED_OTHER*/
    var schedPrio = 0;
    if (attr) {
      stackSize = {{{ makeGetValue('attr', 0, 'i32') }}};
      stackBase = {{{ makeGetValue('attr', 8, 'i32') }}};
      detached = {{{ makeGetValue('attr', 12/*_a_detach*/, 'i32') }}} != 0/*PTHREAD_CREATE_JOINABLE*/;
      var inheritSched = {{{ makeGetValue('attr', 16/*_a_sched*/, 'i32') }}} == 0/*PTHREAD_INHERIT_SCHED*/;
      if (inheritSched) {
        var prevSchedPolicy = {{{ makeGetValue('attr', 20/*_a_policy*/, 'i32') }}};
        var prevSchedPrio = {{{ makeGetValue('attr', 24/*_a_prio*/, 'i32') }}};
        _pthread_getschedparam(_pthread_self(), attr + 20, attr + 24);
        schedPolicy = {{{ makeGetValue('attr', 20/*_a_policy*/, 'i32') }}};
        schedPrio = {{{ makeGetValue('attr', 24/*_a_prio*/, 'i32') }}};
        {{{ makeSetValue('attr', 20/*_a_policy*/, 'prevSchedPolicy', 'i32') }}};
        {{{ makeSetValue('attr', 24/*_a_prio*/, 'prevSchedPrio', 'i32') }}};
      } else {
        schedPolicy = {{{ makeGetValue('attr', 20/*_a_policy*/, 'i32') }}};
        schedPrio = {{{ makeGetValue('attr', 24/*_a_prio*/, 'i32') }}};
      }
    }
    stackSize += 81920 /*DEFAULT_STACK_SIZE*/;
    var allocatedOwnStack = stackBase == 0; // If allocatedOwnStack == true, then the pthread impl maintains the stack allocation.
    if (allocatedOwnStack) {
      stackBase = _malloc(stackSize); // Allocate a stack if the user doesn't want to place the stack in a custom memory area.
    } else {
      // Musl stores the stack base address assuming stack grows downwards, so adjust it to Emscripten convention that the
      // stack grows upwards instead.
      stackBase -= stackSize;
      assert(stackBase > 0);
    }

    // Allocate thread block (pthread_t structure).
    var threadBlock = _malloc({{{ C_STRUCTS.pthread.__size__ }}});
    for(var i = 0; i < {{{ C_STRUCTS.pthread.__size__ }}} >> 2; ++i) HEAPU32[(threadBlock>>2) + i] = 0; // zero-initialize thread structure.
    {{{ makeSetValue('pthread_ptr', 0, 'threadBlock', 'i32') }}};

    // The pthread struct has a field that points to itself - this is used as a magic ID to detect whether the pthread_t
    // structure is 'alive'.
    {{{ makeSetValue('threadBlock', C_STRUCTS.pthread.self, 'threadBlock', 'i32') }}};

    var threadParams = {
      stackBase: stackBase,
      stackSize: stackSize,
      allocatedOwnStack: allocatedOwnStack,
      schedPolicy: schedPolicy,
      schedPrio: schedPrio,
      detached: detached,
      startRoutine: start_routine,
      pthread_ptr: threadBlock,
      arg: arg,
    };

    if (ENVIRONMENT_IS_WORKER) {
      // The prepopulated pool of web workers that can host pthreads is stored in the main JS thread. Therefore if a
      // pthread is attempting to spawn a new thread, the thread creation must be deferred to the main JS thread.
      threadParams.cmd = 'spawnThread';
      postMessage(threadParams);
    } else {
      // We are the main thread, so we have the pthread warmup pool in this thread and can fire off JS thread creation
      // directly ourselves.
      __spawn_thread(threadParams);
    }

    return 0;
  },

  pthread_join__deps: ['_cleanup_thread'],
  pthread_join: function(thread, status) {
    if (!thread) {
      Module['printErr']('pthread_join attempted on a null thread pointer!');
      return ERRNO_CODES.ESRCH;
    }
    if (ENVIRONMENT_IS_PTHREAD && selfThreadId == thread) {
      Module['printErr']('PThread ' + thread + ' is attempting to join to itself!');
      return ERRNO_CODES.EDEADLK;
    }
    else if (!ENVIRONMENT_IS_PTHREAD && PThread.mainThreadBlock == thread) {
      Module['printErr']('Main thread ' + thread + ' is attempting to join to itself!');
      return ERRNO_CODES.EDEADLK;
    }
    var self = {{{ makeGetValue('thread', C_STRUCTS.pthread.self, 'i32') }}};
    if (self != thread) {
      Module['printErr']('pthread_join attempted on thread ' + thread + ', which does not point to a valid thread, or does not exist anymore!');
      return ERRNO_CODES.ESRCH;
    }

    var detached = Atomics.load(HEAPU32, (thread + {{{ C_STRUCTS.pthread.detached }}} ) >> 2);
    if (detached) {
      Module['printErr']('Attempted to join thread ' + thread + ', which was already detached!');
      return ERRNO_CODES.EINVAL; // The thread is already detached, can no longer join it!
    }
    for(;;) {
      var threadStatus = Atomics.load(HEAPU32, (thread + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2);
      if (threadStatus == 1) { // Exited?
        var threadExitCode = Atomics.load(HEAPU32, (thread + {{{ C_STRUCTS.pthread.threadExitCode }}} ) >> 2);
        if (status) {{{ makeSetValue('status', 0, 'threadExitCode', 'i32') }}};
        Atomics.store(HEAPU32, (thread + {{{ C_STRUCTS.pthread.detached }}} ) >> 2, 1); // Mark the thread as detached.

        if (!ENVIRONMENT_IS_WORKER) __cleanup_thread(thread);
        else postMessage({ cmd: 'cleanupThread', thread: thread});
        return 0;
      }
    }
  },

  pthread_kill__deps: ['_kill_thread'],
  pthread_kill: function(thread, signal) {
    if (signal < 0 || signal >= 65/*_NSIG*/) return ERRNO_CODES.EINVAL;
    if (thread == PThread.MAIN_THREAD_ID) {
      if (signal == 0) return 0; // signal == 0 is a no-op.
      Module['printErr']('Main thread (id=' + thread + ') cannot be killed with pthread_kill!');
      return ERRNO_CODES.ESRCH;
    }
    if (!thread) {
      Module['printErr']('pthread_kill attempted on a null thread pointer!');
      return ERRNO_CODES.ESRCH;
    }
    var self = {{{ makeGetValue('thread', C_STRUCTS.pthread.self, 'i32') }}};
    if (self != thread) {
      Module['printErr']('pthread_kill attempted on thread ' + thread + ', which does not point to a valid thread, or does not exist anymore!');
      return ERRNO_CODES.ESRCH;
    }
    if (signal != 0) {
      if (!ENVIRONMENT_IS_WORKER) __kill_thread(thread);
      else postMessage({ cmd: 'killThread', thread: thread});
    }
    return 0;
  },

  pthread_cancel__deps: ['_cancel_thread'],
  pthread_cancel: function(thread) {
    if (thread == PThread.MAIN_THREAD_ID) {
      Module['printErr']('Main thread (id=' + thread + ') cannot be canceled!');
      return ERRNO_CODES.ESRCH;
    }
    if (!thread) {
      Module['printErr']('pthread_cancel attempted on a null thread pointer!');
      return ERRNO_CODES.ESRCH;
    }
    var self = {{{ makeGetValue('thread', C_STRUCTS.pthread.self, 'i32') }}};
    if (self != thread) {
      Module['printErr']('pthread_cancel attempted on thread ' + thread + ', which does not point to a valid thread, or does not exist anymore!');
      return ERRNO_CODES.ESRCH;
    }
    Atomics.compareExchange(HEAPU32, (thread + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2, 0, 2); // Signal the thread that it needs to cancel itself.
    if (!ENVIRONMENT_IS_WORKER) __cancel_thread(thread);
    else postMessage({ cmd: 'cancelThread', thread: thread});
    return 0;
  },

  pthread_testcancel: function() {
    if (!ENVIRONMENT_IS_PTHREAD) return;
    if (!threadBlock) return;
    if (PThread.thisThreadCancelState != 0/*PTHREAD_CANCEL_ENABLE*/) return;
    var canceled = Atomics.load(HEAPU32, (threadBlock + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2);
    if (canceled == 2) throw 'Canceled!';
  },

  pthread_setcancelstate: function(state, oldstate) {
    if (state != 0 && state != 1) return ERRNO_CODES.EINVAL;
    if (oldstate) {{{ makeSetValue('oldstate', 0, 'PThread.thisThreadCancelState', 'i32') }}};
    PThread.thisThreadCancelState = state;

    if (PThread.thisThreadCancelState == 0/*PTHREAD_CANCEL_ENABLE*/
      && PThread.thisThreadCancelType == 1/*PTHREAD_CANCEL_ASYNCHRONOUS*/ && ENVIRONMENT_IS_PTHREAD) {
      // If we are re-enabling cancellation, immediately test whether this thread has been queued to be cancelled,
      // and if so, do it. However, we can only do this if the cancel state of current thread is
      // PTHREAD_CANCEL_ASYNCHRONOUS, since this function pthread_setcancelstate() is not a cancellation point.
      // See http://man7.org/linux/man-pages/man7/pthreads.7.html
      var canceled = Atomics.load(HEAPU32, (threadBlock + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2);
      if (canceled == 2) {
        throw 'Canceled!';
      }
    }
    return 0;
  },

  pthread_setcanceltype: function(type, oldtype) {
    if (type != 0 && type != 1) return ERRNO_CODES.EINVAL;
    if (oldtype) {{{ makeSetValue('oldtype', 0, 'PThread.thisThreadCancelType', 'i32') }}};
    PThread.thisThreadCancelType = type;
    return 0;
  },

  pthread_detach: function(thread) {
    if (!thread) {
      Module['printErr']('pthread_detach attempted on a null thread pointer!');
      return ERRNO_CODES.ESRCH;
    }
    var self = {{{ makeGetValue('thread', C_STRUCTS.pthread.self, 'i32') }}};
    if (self != thread) {
      Module['printErr']('pthread_detach attempted on thread ' + thread + ', which does not point to a valid thread, or does not exist anymore!');
      return ERRNO_CODES.ESRCH;
    }
    var threadStatus = Atomics.load(HEAPU32, (thread + {{{ C_STRUCTS.pthread.threadStatus }}} ) >> 2);
    // Follow musl convention: detached:0 means not detached, 1 means the thread was created as detached, and 2 means that the thread was detached via pthread_detach.
    var wasDetached = Atomics.compareExchange(HEAPU32, (thread + {{{ C_STRUCTS.pthread.detached }}} ) >> 2, 0, 2);
    return wasDetached ? (threadStatus == 0/*running*/ ? ERRNO_CODES.EINVAL : ERRNO_CODES.ESRCH) : 0;
  },

  pthread_exit__deps: ['exit'],
  pthread_exit: function(status) {
    if (!ENVIRONMENT_IS_PTHREAD) _exit(status);
    else PThread.threadExit(status);
  },

  // Public pthread_self() function which returns a unique ID for the thread.
  pthread_self: function() {
    if (ENVIRONMENT_IS_PTHREAD) return selfThreadId;
    return 1; // Main JS thread
  },

  // pthread internal self() function which returns a pointer to the C control block for the thread.
  // pthread_self() and __pthread_self() are separate so that we can ensure that each thread gets its unique ID
  // using an incremented running counter, which helps in debugging.
  __pthread_self__deps: ['$PROCINFO'],
  __pthread_self: function() {
    if (ENVIRONMENT_IS_PTHREAD) return threadBlock;
    return PThread.mainThreadBlock; // Main JS thread.
  },

  pthread_getschedparam: function(thread, policy, schedparam) {
    if (!policy && !schedparam) return ERRNO_CODES.EINVAL;

    var tb;
    if (ENVIRONMENT_IS_PTHREAD) {
      if (thread != selfThreadId) {
        Module['printErr']('TODO: Currently non-main threads can only pthread_getschedparam themselves!');
        return ERRNO_CODES.ESRCH;
      }
      if (!threadBlock) {
        Module['printErr']('PThread ' + thread + ' does not exist!');
        return ERRNO_CODES.ESRCH;
      }
      tb = threadBlock;
    } else {
      if (thread == PThread.MAIN_THREAD_ID) {
        if (policy) {{{ makeSetValue('policy', 0, 'PThread.mainThreadInfo.schedPolicy', 'i32') }}};
        if (schedparam) {{{ makeSetValue('schedparam', 0, 'PThread.mainThreadInfo.schedPrio', 'i32') }}};
        return 0;
      }
      var threadInfo = PThread.pthreads[thread];
      if (!threadInfo) return ERRNO_CODES.ESRCH;
      tb = threadInfo.threadBlock;
    }

    var schedPolicy = Atomics.load(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 20 ) >> 2);
    var schedPrio = Atomics.load(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 24 ) >> 2);

    if (policy) {{{ makeSetValue('policy', 0, 'schedPolicy', 'i32') }}};
    if (schedparam) {{{ makeSetValue('schedparam', 0, 'schedPrio', 'i32') }}};
    return 0;
  },

  pthread_setschedparam: function(thread, policy, schedparam) {
    if (!schedparam) return ERRNO_CODES.EINVAL;
    var newSchedPrio = {{{ makeGetValue('schedparam', 0, 'i32') }}};
    if (newSchedPrio < 0) return ERRNO_CODES.EINVAL;
    if (policy == 1/*SCHED_FIFO*/ || policy == 2/*SCHED_RR*/) {
      if (newSchedPrio > 99) return ERRNO_CODES.EINVAL;
    } else {
      if (newSchedPrio > 1) return ERRNO_CODES.EINVAL;
    }

    var tb;
    if (ENVIRONMENT_IS_PTHREAD) {
      if (thread != selfThreadId) {
        Module['printErr']('TODO: Currently non-main threads can only pthread_setschedparam themselves!');
        return ERRNO_CODES.ESRCH;
      }
      if (!threadBlock) {
        Module['printErr']('PThread ' + thread + ' does not exist!');
        return ERRNO_CODES.ESRCH;
      }
      tb = threadBlock;
    } else {
      if (thread == PThread.MAIN_THREAD_ID) {
        PThread.mainThreadInfo.schedPolicy = policy;
        PThread.mainThreadInfo.schedPrio = {{{ makeGetValue('schedparam', 0, 'i32') }}};
        return 0;
      }
      var threadInfo = PThread.pthreads[thread];
      if (!threadInfo) return ERRNO_CODES.ESRCH;
      tb = threadInfo.threadBlock;
    }

    Atomics.store(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 20) >> 2, policy);
    Atomics.store(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 24) >> 2, newSchedPrio);
    return 0;
  },

  // Marked as obsolescent in pthreads specification: http://pubs.opengroup.org/onlinepubs/9699919799/functions/pthread_getconcurrency.html
  pthread_getconcurrency: function() {
    return 0;
  },

  // Marked as obsolescent in pthreads specification.
  pthread_setconcurrency: function(new_level) {
    // no-op
    return 0;
  },

  pthread_mutexattr_getprioceiling: function(attr, prioceiling) {
    // Not supported either in Emscripten or musl, return a faked value.
    if (prioceiling) {{{ makeSetValue('prioceiling', 0, 99, 'i32') }}};
    return 0;
  },

  pthread_mutexattr_setprioceiling: function(attr, prioceiling) {
    // Not supported either in Emscripten or musl, return an error.
    return ERRNO_CODES.EPERM;
  },

  pthread_getcpuclockid: function(thread, clock_id) {
    return ERRNO_CODES.ENOENT; // pthread API recommends returning this error when "Per-thread CPU time clocks are not supported by the system."
  },

  pthread_setschedprio: function(thread, prio) {
    var tb;
    if (prio < 0) return ERRNO_CODES.EINVAL;
    if (ENVIRONMENT_IS_PTHREAD) {
      if (thread != selfThreadId) {
        Module['printErr']('TODO: Currently non-main threads can only pthread_setschedprio themselves!');
        return ERRNO_CODES.ESRCH;
      }
      if (!threadBlock) {
        Module['printErr']('PThread ' + thread + ' does not exist!');
        return ERRNO_CODES.ESRCH;
      }
      tb = threadBlock;
    } else {
      if (thread == PThread.MAIN_THREAD_ID) {
        if (PThread.mainThreadInfo.schedPolicy == 1/*SCHED_FIFO*/ || PThread.mainThreadInfo.schedPolicy == 2/*SCHED_RR*/) {
          if (prio > 99) return ERRNO_CODES.EINVAL;
        } else {
          if (prio > 1) return ERRNO_CODES.EINVAL;
        }
        PThread.mainThreadInfo.schedPrio = {{{ makeGetValue('prio', 0, 'i32') }}};
        return 0;
      }
      var threadInfo = PThread.pthreads[thread];
      if (!threadInfo) return ERRNO_CODES.ESRCH;
      tb = threadInfo.threadBlock;
    }
    var schedPolicy = Atomics.load(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 20 ) >> 2);

    if (schedPolicy == 1/*SCHED_FIFO*/ || schedPolicy == 2/*SCHED_RR*/) {
      if (prio > 99) return ERRNO_CODES.EINVAL;
    } else {
      if (prio > 1) return ERRNO_CODES.EINVAL;
    }

    Atomics.store(HEAPU32, (tb + {{{ C_STRUCTS.pthread.attr }}} + 24) >> 2, prio);
    return 0;
  },

  pthread_cleanup_push: function(routine, arg) {
    if (PThread.exitHandlers === null) {
      PThread.exitHandlers = [];
      if (!ENVIRONMENT_IS_PTHREAD) {
        __ATEXIT__.push({ func: function() { PThread.runExitHandlers(); } });
      }
    }
    PThread.exitHandlers.push(function() { Runtime.dynCall('vi', routine, [arg]) });
  },

  pthread_cleanup_pop: function(execute) {
    var routine = PThread.exitHandlers.pop();
    if (execute) routine();
  },

  // pthread_sigmask - examine and change mask of blocked signals
  pthread_sigmask: function(how, set, oldset) {
    Module['printErr']('pthread_sigmask() is not supported: this is a no-op.');
    return 0;
  },

  pthread_atfork: function(prepare, parent, child) {
    Module['printErr']('fork() is not supported: pthread_atfork is a no-op.');
    return 0;
  },

  // Returns 0 on success, or one of the values -ETIMEDOUT, -EWOULDBLOCK or -EINVAL on error.
  emscripten_futex_wait: function(addr, val, timeout) {
    if (addr <= 0 || addr > HEAP8.length || addr&3 != 0) return -{{{ cDefine('EINVAL') }}};
    var ret = Atomics.futexWait(HEAP32, addr >> 2, val, timeout);
    if (ret == Atomics.TIMEDOUT) return -{{{ cDefine('ETIMEDOUT') }}};
    if (ret == Atomics.NOTEQUAL) return -{{{ cDefine('EWOULDBLOCK') }}};
    if (ret == 0) return 0;
    throw 'Atomics.futexWait returned an unexpected value ' + ret;
  },

  // Returns the number of threads (>= 0) woken up, or the value -EINVAL on error.
  emscripten_futex_wake: function(addr, count) {
    if (addr <= 0 || addr > HEAP8.length || addr&3 != 0 || count < 0) return -{{{ cDefine('EINVAL') }}};
    var ret = Atomics.futexWake(HEAP32, addr >> 2, count);
    if (ret >= 0) return ret;
    throw 'Atomics.futexWake returned an unexpected value ' + ret;
  },

  // Returns the number of threads (>= 0) woken up, or one of the values -EINVAL or -EAGAIN on error.
  emscripten_futex_wake_or_requeue: function(addr, count, cmpValue, addr2) {
    if (addr <= 0 || addr2 <= 0 || addr >= HEAP8.length || addr2 >= HEAP8.length || count < 0
      || addr&3 != 0 || addr2&3 != 0) {
      return -{{{ cDefine('EINVAL') }}};
    }
    var ret = Atomics.futexWakeOrRequeue(HEAP32, addr >> 2, count, cmpValue, addr >> 2);
    if (ret == Atomics.NOTEQUAL) return -{{{ cDefine('EAGAIN') }}};
    if (ret >= 0) return ret;
    throw 'Atomics.futexWakeOrRequeue returned an unexpected value ' + ret;
  }
};

autoAddDeps(LibraryPThread, '$PThread');
mergeInto(LibraryManager.library, LibraryPThread);
