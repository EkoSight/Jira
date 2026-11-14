package com.ekosight.taskflow.phone;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;

/**
 * Watches a call TaskFlow placed: when the phone goes back to idle after the
 * call, the call log is read (its exact length) and the person is reminded to
 * say how it went. Needs the phone permission; stops by itself after three hours.
 */
@SuppressLint("MissingPermission") // started only after the phone permission is checked; a SecurityException is caught
final class CallWatcher {
    interface Ended {
        void onEnded();
    }

    private final Context ctx;
    private final TelephonyManager telephony;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Object listener;
    private boolean active;
    private boolean sawCall;
    private Ended ended;

    CallWatcher(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.telephony = this.ctx.getSystemService(TelephonyManager.class);
    }

    synchronized void start(Ended onEnded) {
        stop();
        if (telephony == null) return;
        ended = onEnded;
        sawCall = false;
        active = true;
        main.post(this::register);
        main.postDelayed(this::stop, 3 * 3_600_000L);
    }

    private synchronized void changed(int state) {
        if (!active) return;
        if (state == TelephonyManager.CALL_STATE_OFFHOOK || state == TelephonyManager.CALL_STATE_RINGING) {
            sawCall = true;
        } else if (state == TelephonyManager.CALL_STATE_IDLE && sawCall) {
            Ended done = ended;
            stop();
            if (done != null) done.onEnded();
        }
    }

    @SuppressWarnings("deprecation")
    private void register() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                Modern cb = new Modern(this);
                telephony.registerTelephonyCallback(ctx.getMainExecutor(), cb);
                listener = cb;
            } else {
                Legacy l = new Legacy(this);
                telephony.listen(l, PhoneStateListener.LISTEN_CALL_STATE);
                listener = l;
            }
        } catch (SecurityException e) {
            listener = null;
        }
    }

    @SuppressWarnings("deprecation")
    synchronized void stop() {
        active = false;
        main.removeCallbacksAndMessages(null);
        Object l = listener;
        listener = null;
        if (l == null || telephony == null) return;
        if (Build.VERSION.SDK_INT >= 31 && l instanceof TelephonyCallback) telephony.unregisterTelephonyCallback((TelephonyCallback) l);
        else if (l instanceof PhoneStateListener) telephony.listen((PhoneStateListener) l, PhoneStateListener.LISTEN_NONE);
    }

    /** Android 12 and later. */
    private static final class Modern extends TelephonyCallback implements TelephonyCallback.CallStateListener {
        private final CallWatcher watcher;

        Modern(CallWatcher watcher) { this.watcher = watcher; }

        @Override
        public void onCallStateChanged(int state) { watcher.changed(state); }
    }

    /** Android 11 and earlier. */
    @SuppressWarnings("deprecation")
    private static final class Legacy extends PhoneStateListener {
        private final CallWatcher watcher;

        Legacy(CallWatcher watcher) { this.watcher = watcher; }

        @Override
        public void onCallStateChanged(int state, String phoneNumber) { watcher.changed(state); }
    }
}
