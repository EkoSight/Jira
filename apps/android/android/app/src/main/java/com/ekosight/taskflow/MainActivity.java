package com.ekosight.taskflow;

import android.os.Bundle;
import com.ekosight.taskflow.phone.TaskFlowPhonePlugin;
import com.getcapacitor.BridgeActivity;

/** TaskFlow in a thin Android shell, with the phone features (TaskFlowPhone) offered to TaskFlow's own pages. */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TaskFlowPhonePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
