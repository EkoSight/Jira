package com.ekosight.taskflow.phone;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The recordings folder the person chose (Android's folder picker). TaskFlow
 * reads, and removes files, only inside it, through the permission that
 * choice gave; it needs no permission over the phone's other files.
 */
final class Folder {
    private Folder() {}

    private static final String[] COLUMNS = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_SIZE,
    };
    private static final int MAX_FILES = 2000;

    /** Audio files saved since the given time, in the folder and up to two folders down (some diallers file by date). */
    static List<RecordingMatcher.FileInfo> list(Context ctx, Uri tree, long since) {
        List<RecordingMatcher.FileInfo> out = new ArrayList<>();
        walk(ctx.getContentResolver(), tree, DocumentsContract.getTreeDocumentId(tree), since, 0, out);
        return out;
    }

    private static void walk(ContentResolver resolver, Uri tree, String docId, long since, int depth, List<RecordingMatcher.FileInfo> out) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        List<String> folders = new ArrayList<>();
        try (Cursor c = resolver.query(children, COLUMNS, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext() && out.size() < MAX_FILES) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long modified = c.isNull(3) ? 0 : c.getLong(3);
                long size = c.isNull(4) ? 0 : c.getLong(4);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) folders.add(id);
                else if (modified >= since && RecordingMatcher.isAudio(name)) out.add(new RecordingMatcher.FileInfo(id, name, modified, size));
            }
        } catch (SecurityException e) {
            // the folder permission was withdrawn: nothing is read
            return;
        }
        if (depth < 2) for (String f : folders) walk(resolver, tree, f, since, depth + 1, out);
    }

    static InputStream open(Context ctx, Uri tree, String docId) throws FileNotFoundException {
        InputStream in = ctx.getContentResolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, docId));
        if (in == null) throw new FileNotFoundException(docId);
        return in;
    }

    /** Removes one file (TaskFlow has it, or the lead asked not to be recorded). Nothing else is ever touched. */
    static boolean delete(Context ctx, Uri tree, String docId) {
        try {
            return DocumentsContract.deleteDocument(ctx.getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, docId));
        } catch (FileNotFoundException | SecurityException | IllegalArgumentException e) {
            return false;
        }
    }

    /** The folder's name, as the person saw it in the picker. */
    static String name(Context ctx, Uri tree) {
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor c = ctx.getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            return c != null && c.moveToFirst() ? c.getString(0) : null;
        } catch (SecurityException e) {
            return null;
        }
    }

    static String mimeOf(String name) {
        String n = name.toLowerCase(java.util.Locale.ROOT);
        if (n.endsWith(".m4a") || n.endsWith(".mp4") || n.endsWith(".aac")) return "audio/mp4";
        if (n.endsWith(".amr")) return "audio/amr";
        if (n.endsWith(".3gp") || n.endsWith(".3ga")) return "audio/3gpp";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".ogg") || n.endsWith(".opus")) return "audio/ogg";
        if (n.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
