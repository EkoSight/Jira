package com.ekosight.taskflow.phone;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Syncing in the background: every 15 minutes (Android's shortest period)
 * when there is a connection, and soon after a call TaskFlow placed ends.
 * Survives a restart of the phone. Android's own scheduler is used, so the
 * app needs no extra library.
 */
public class SyncJob extends JobService {
    private static final int PERIODIC = 0x7a51;
    private static final int SOON = 0x7a52;

    @Override
    public boolean onStartJob(JobParameters params) {
        Thread t = new Thread(() -> {
            SyncEngine.Outcome o = SyncEngine.run(getApplicationContext());
            jobFinished(params, o.retry);
        }, "taskflow-sync");
        t.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // stopped by Android (no connection any more, the phone needs the battery): try again later
        return true;
    }

    /** The 15-minute sync. Left as it is when already scheduled, so opening the app does not keep pushing it back. */
    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(PERIODIC) != null) return;
        js.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(ctx, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15 * 60_000L)
            .setPersisted(true)
            .build());
    }

    /** One sync shortly (after a call, or when the app opens). */
    static void soon(Context ctx, long delayMs) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null) return;
        js.schedule(new JobInfo.Builder(SOON, new ComponentName(ctx, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(delayMs)
            .setOverrideDeadline(delayMs + 5 * 60_000L)
            .build());
    }

    static void cancel(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null) return;
        js.cancel(PERIODIC);
        js.cancel(SOON);
    }
}
