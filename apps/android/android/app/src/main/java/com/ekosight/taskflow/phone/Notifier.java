package com.ekosight.taskflow.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** The app's few notifications: a call ended (say how it went), and syncing needs attention. */
final class Notifier {
    private Notifier() {}

    private static final String CHANNEL = "taskflow-calls";
    private static final int CALL_ENDED = 4101;
    private static final int ATTENTION = 4102;

    static void createChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Calls with leads", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("After a call from TaskFlow ends, and when the phone needs attention");
        nm.createNotificationChannel(ch);
    }

    static void callEnded(Context ctx) {
        show(ctx, CALL_ENDED, "How did the call go?", "Open TaskFlow to say how it went and book the next step.");
    }

    static void attention(Context ctx, String text) {
        show(ctx, ATTENTION, "TaskFlow needs attention on this phone", text);
    }

    @SuppressWarnings("deprecation")
    private static void show(Context ctx, int id, String title, String text) {
        if (!DeviceFacts.canNotify(ctx)) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return;
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) return;
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true);
        nm.notify(id, b.build());
    }
}
