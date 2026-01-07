<script setup lang="ts">
import { ref, onMounted } from 'vue';
import yaml from 'js-yaml';
import { provideVSCodeDesignSystem, vsCodeButton, vsCodeTextArea, vsCodePanels, vsCodePanelTab, vsCodePanelView, vsCodeDivider, vsCodeTextField, vsCodeCheckbox, vsCodeDropdown, vsCodeOption } from "@vscode/webview-ui-toolkit";

// Register Web Components
provideVSCodeDesignSystem().register(
  vsCodeButton(), 
  vsCodeTextArea(), 
  vsCodePanels(), 
  vsCodePanelTab(), 
  vsCodePanelView(),
  vsCodeDivider(),
  vsCodeTextField(),
  vsCodeCheckbox(),
  vsCodeDropdown(),
  vsCodeOption()
);

// VS Code API type definition
declare const acquireVsCodeApi: () => {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

let vscode: any;
try {
  vscode = acquireVsCodeApi();
} catch (e) {
  console.log("Not running in VS Code Webview");
}

const rawText = ref('');
const fragments = ref<any[]>([]);
const parseError = ref('');

// Schema definitions based on clangd.json
const schema = {
  // This would ideally be loaded or imported.
  // For now, we manually map some fields.
}

onMounted(() => {
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'update':
        rawText.value = message.text;
        parseYaml(message.text);
        break;
    }
  });

  // Request initial data
  if (vscode) {
    vscode.postMessage({ type: 'ready' });
  }
});

function parseYaml(text: string) {
  try {
    // .clangd supports multiple documents separated by ---
    // js-yaml loadAll returns an array
    const docs = yaml.loadAll(text);
    fragments.value = docs.map((doc: any, index: number) => ({
      id: index,
      content: doc || {}
    }));
    parseError.value = '';
  } catch (e: any) {
    parseError.value = e.message;
  }
}

function updateContent() {
  if (!vscode) return;
  
  try {
    const text = fragments.value.map(f => yaml.dump(f.content)).join('\n---\n');
    vscode.postMessage({
        type: 'change',
        text: text
    });
  } catch (e) {
    console.error("Failed to dump yaml", e);
  }
}

function addFragment() {
    fragments.value.push({
        id: Date.now(),
        content: {
            If: { PathMatch: ['.*\\.h'] },
            CompileFlags: { Add: [] }
        }
    });
    updateContent();
}

function removeFragment(index: number) {
    fragments.value.splice(index, 1);
    updateContent();
}

function updateField(fragmentIndex: number, section: string, key: string, value: any) {
    if (!fragments.value[fragmentIndex].content[section]) {
        fragments.value[fragmentIndex].content[section] = {};
    }
    fragments.value[fragmentIndex].content[section][key] = value;
    updateContent();
}

// Simple helper to get value safely
function getValue(fragmentIndex: number, section: string, key: string, defaultVal: any = '') {
    return fragments.value[fragmentIndex]?.content?.[section]?.[key] ?? defaultVal;
}
</script>

<template>
  <div class="container">
    <div v-if="parseError" class="error">
      Error parsing YAML: {{ parseError }}
    </div>

    <div v-for="(fragment, index) in fragments" :key="fragment.id" class="fragment-card">
      <div class="fragment-header">
        <h3>Fragment #{{ index + 1 }}</h3>
        <vscode-button appearance="icon" @click="removeFragment(index)">
           <span class="codicon codicon-trash">X</span>
        </vscode-button>
      </div>
      
      <vscode-panels>
        <vscode-panel-tab :id="'tab-if-'+index">Conditions (If)</vscode-panel-tab>
        <vscode-panel-tab :id="'tab-flags-'+index">Compile Flags</vscode-panel-tab>
        <vscode-panel-tab :id="'tab-diagnostics-'+index">Diagnostics</vscode-panel-tab>
        <vscode-panel-tab :id="'tab-index-'+index">Index</vscode-panel-tab>
        <vscode-panel-tab :id="'tab-features-'+index">Features</vscode-panel-tab>
        
        <vscode-panel-view :id="'view-if-'+index">
          <div class="form-group">
             <label>PathMatch (Regex)</label>
             <!-- Simplified: assuming string or array of strings. UI only handles commma separated for now or raw input -->
             <vscode-text-field 
                :value="getValue(index, 'If', 'PathMatch')" 
                @input="(e: any) => updateField(index, 'If', 'PathMatch', e.target.value)"
                placeholder=".*\.h"
                class="full-width"
             ></vscode-text-field>
          </div>
           <div class="form-group">
             <label>PathExclude (Regex)</label>
             <vscode-text-field 
                :value="getValue(index, 'If', 'PathExclude')" 
                @input="(e: any) => updateField(index, 'If', 'PathExclude', e.target.value)"
                placeholder="vendor/.*"
                class="full-width"
             ></vscode-text-field>
          </div>
        </vscode-panel-view>

        <vscode-panel-view :id="'view-flags-'+index">
             <div class="form-group">
                <label>Add Flags</label>
                <vscode-text-area
                    resize="vertical"
                    :value="JSON.stringify(getValue(index, 'CompileFlags', 'Add', []), null, 2)"
                    @input="(e: any) => { try { updateField(index, 'CompileFlags', 'Add', JSON.parse(e.target.value)) } catch(err){} }"
                    placeholder='["-Wall", "-Wextra"]'
                    class="full-width"
                ></vscode-text-area>
                <span class="hint">Enter as JSON array of strings</span>
            </div>
             <div class="form-group">
                <label>Remove Flags</label>
                <vscode-text-area
                    resize="vertical"
                    :value="JSON.stringify(getValue(index, 'CompileFlags', 'Remove', []), null, 2)"
                    @input="(e: any) => { try { updateField(index, 'CompileFlags', 'Remove', JSON.parse(e.target.value)) } catch(err){} }"
                    placeholder='["-Wold-style-cast"]'
                    class="full-width"
                ></vscode-text-area>
            </div>
             <div class="form-group">
             <label>Compiler</label>
             <vscode-text-field 
                :value="getValue(index, 'CompileFlags', 'Compiler')" 
                @input="(e: any) => updateField(index, 'CompileFlags', 'Compiler', e.target.value)"
                placeholder="clang++"
             ></vscode-text-field>
          </div>
        </vscode-panel-view>

        <vscode-panel-view :id="'view-diagnostics-'+index">
            <div class="form-group">
                <label>Suppress</label>
                 <vscode-text-area
                    resize="vertical"
                    :value="JSON.stringify(getValue(index, 'Diagnostics', 'Suppress', []), null, 2)"
                    @input="(e: any) => { try { updateField(index, 'Diagnostics', 'Suppress', JSON.parse(e.target.value)) } catch(err){} }"
                    class="full-width"
                ></vscode-text-area>
            </div>
            <h4>ClangTidy</h4>
            <div class="form-group">
                <label>Add Checks</label>
                <vscode-text-area
                    resize="vertical"
                    :value="JSON.stringify(getValue(index, 'Diagnostics', 'ClangTidy', {}).Add || [], null, 2)"
                    @input="(e: any) => { 
                        const dt = getValue(index, 'Diagnostics', 'ClangTidy', {});
                        try { dt.Add = JSON.parse(e.target.value); updateField(index, 'Diagnostics', 'ClangTidy', dt); } catch(err){} 
                    }"
                    class="full-width"
                ></vscode-text-area>
            </div>
        </vscode-panel-view>
        
        <vscode-panel-view :id="'view-index-'+index">
             <div class="form-group">
                <vscode-checkbox 
                    :checked="getValue(index, 'Index', 'StandardLibrary') === true"
                    @change="(e: any) => updateField(index, 'Index', 'StandardLibrary', e.target.checked)"
                >Standard Library</vscode-checkbox>
            </div>
             <div class="form-group">
                <label>Background</label>
                <vscode-dropdown
                    :value="getValue(index, 'Index', 'Background', 'Build')"
                    @change="(e: any) => updateField(index, 'Index', 'Background', e.target.value)"
                >
                    <vscode-option value="Build">Build</vscode-option>
                    <vscode-option value="Skip">Skip</vscode-option>
                </vscode-dropdown>
            </div>
        </vscode-panel-view>

        <vscode-panel-view :id="'view-features-'+index">
             <h4>Inlay Hints</h4>
             <div class="form-group">
                <vscode-checkbox 
                    :checked="getValue(index, 'InlayHints', 'Enabled') === true"
                    @change="(e: any) => updateField(index, 'InlayHints', 'Enabled', e.target.checked)"
                >Enabled</vscode-checkbox>
                 <vscode-checkbox 
                    :checked="getValue(index, 'InlayHints', 'ParameterNames') === true"
                    @change="(e: any) => updateField(index, 'InlayHints', 'ParameterNames', e.target.checked)"
                >Parameter Names</vscode-checkbox>
                 <vscode-checkbox 
                    :checked="getValue(index, 'InlayHints', 'DeducedTypes') === true"
                    @change="(e: any) => updateField(index, 'InlayHints', 'DeducedTypes', e.target.checked)"
                >Deduced Types</vscode-checkbox>
            </div>
            
            <h4>Hover</h4>
             <div class="form-group">
                 <vscode-checkbox 
                    :checked="getValue(index, 'Hover', 'ShowAKA') === true"
                    @change="(e: any) => updateField(index, 'Hover', 'ShowAKA', e.target.checked)"
                >Show AKA</vscode-checkbox>
            </div>

            <h4>Completion</h4>
             <div class="form-group">
                <vscode-checkbox 
                    :checked="getValue(index, 'Completion', 'AllScopes', 'Yes') === 'Yes'"
                    @change="(e: any) => updateField(index, 'Completion', 'AllScopes', e.target.checked ? 'Yes' : 'No')"
                >All Scopes</vscode-checkbox>
            </div>
        </vscode-panel-view>
      </vscode-panels>
    </div>

    <div class="actions">
        <vscode-button @click="addFragment">Add Fragment</vscode-button>
    </div>
  </div>
</template>

<style>
body {
    padding: 0;
    margin: 0;
}
.container {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 800px;
    margin: 0 auto;
}
.fragment-card {
    border: 1px solid var(--vscode-widget-border);
    background: var(--vscode-editor-background);
    padding: 10px;
}
.fragment-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--vscode-widget-border);
    padding-bottom: 10px;
    margin-bottom: 10px;
}
.form-group {
    margin-bottom: 15px;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.full-width {
    width: 100%;
}
.error {
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-errorForeground);
    padding: 10px;
}
.hint {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
}
</style>
