// Make showTab globally accessible
window.showTab = function showTab(tabName, event) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    // Show selected tab
    const targetTab = document.getElementById(tabName);
    if (targetTab) {
        targetTab.classList.add('active');
    }
    
    // Add active class to the corresponding nav tab
    if (event && event.target) {
        const clickedTab = event.target;
        if (clickedTab && clickedTab.classList.contains('nav-tab')) {
            clickedTab.classList.add('active');
        }
    } else {
        // If no event provided, find the nav tab by href
        const navTab = document.querySelector('a[href="#' + tabName + '"]');
        if (navTab && navTab.classList.contains('nav-tab')) {
            navTab.classList.add('active');
        }
    }
}

window.searchRepos = function searchRepos(query) {
    if (query.length > 2) {
        htmx.ajax('GET', '/research/results?search=' + encodeURIComponent(query), {
            target: '#repos .section-content'
        });
    }
}

// Auto-refresh operations every 15 seconds when tab is active
setInterval(() => {
    if (document.getElementById('operations').classList.contains('active')) {
        htmx.trigger('#operations .section-content', 'load');
    }
}, 15000);

// Handle URL hash changes (e.g., #practices, #operations, etc.)
function handleHashChange() {
    const hash = window.location.hash.substring(1);
    if (hash) {
        const navTab = document.querySelector('a[href="#' + hash + '"]');
        if (navTab && navTab.classList.contains('nav-tab')) {
            showTab(hash, { target: navTab });
        }
    }
}

// Listen for hash changes
window.addEventListener('hashchange', handleHashChange);

// Handle initial page load with hash
document.addEventListener('DOMContentLoaded', handleHashChange);

// Also handle it after a short delay
setTimeout(handleHashChange, 100);

// Research modal functionality
window.showResearchModal = function showResearchModal() {
    document.getElementById('researchModal').style.display = 'block';
    document.getElementById('frontendPassword').value = '';
    document.getElementById('researchStatus').style.display = 'none';
}

window.closeResearchModal = function closeResearchModal() {
    document.getElementById('researchModal').style.display = 'none';
}

window.startResearchSweep = async function startResearchSweep() {
    const frontendPassword = document.getElementById('frontendPassword').value.trim();
    const statusDiv = document.getElementById('researchStatus');
    
    if (!frontendPassword) {
        alert('Please enter the frontend password.');
        return;
    }

    // Show status
    statusDiv.style.display = 'block';
    statusDiv.innerHTML = 'Starting research sweep...';
    
    try {
        const response = await fetch('/research/run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Frontend-Password': frontendPassword
            },
            body: JSON.stringify({})
        });

        if (response.ok) {
            statusDiv.innerHTML = '✅ Research sweep started successfully!<br>Check the <a href="#operations" onclick="showTab(\'operations\', event); return false;">Live Operations</a> tab to monitor progress.';
            statusDiv.style.color = '#28a745';
            
            // Close modal after 3 seconds
            setTimeout(() => {
                closeResearchModal();
                showTab('operations');
            }, 3000);
        } else {
            const errorText = await response.text();
            statusDiv.innerHTML = '❌ Failed to start research sweep: ' + response.status + ' ' + errorText;
            statusDiv.style.color = '#d73a49';
        }
    } catch (error) {
        statusDiv.innerHTML = '❌ Error: ' + (error instanceof Error ? error.message : String(error));
        statusDiv.style.color = '#d73a49';
    }
}

// Operation detail modal functions
window.showOperationDetail = async function showOperationDetail(operationId) {
    const modal = document.getElementById('operationDetailModal');
    const content = document.getElementById('operationDetailContent');
    
    modal.style.display = 'block';
    content.innerHTML = '<div class="loading">Loading operation details...</div>';
    
    try {
        const response = await fetch(`/api/operations/${operationId}`);
        if (!response.ok) {
            throw new Error(`Failed to load operation details: ${response.status}`);
        }
        
        const operation = await response.json();
        
        const timeAgo = operation.updated_at ? 
            Math.round((Date.now() - operation.updated_at) / 1000) : 0;
        const timeText = timeAgo < 60 ? `${timeAgo}s ago` : 
            timeAgo < 3600 ? `${Math.round(timeAgo / 60)}m ago` : 
            `${Math.round(timeAgo / 3600)}h ago`;
        
        const createdTime = new Date(operation.created_at).toLocaleString();
        const updatedTime = new Date(operation.updated_at).toLocaleString();
        
        content.innerHTML = `
            <div class="operation-detail">
                <div class="detail-section">
                    <h4>Operation Information</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <strong>Operation ID:</strong>
                            <span class="operation-id">${operation.operation_id}</span>
                        </div>
                        <div class="detail-item">
                            <strong>Type:</strong>
                            <span>${operation.operation_type || 'Unknown'}</span>
                        </div>
                        <div class="detail-item">
                            <strong>Repository:</strong>
                            <span class="repo-link">${operation.repo || 'Unknown'}</span>
                        </div>
                        ${operation.pr_number ? `
                        <div class="detail-item">
                            <strong>PR Number:</strong>
                            <span>#${operation.pr_number}</span>
                        </div>
                        ` : ''}
                        <div class="detail-item">
                            <strong>Status:</strong>
                            <span class="status ${operation.status}">${operation.status}</span>
                        </div>
                        <div class="detail-item">
                            <strong>Progress:</strong>
                            <span>${operation.progress_percent || 0}%</span>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${operation.progress_percent || 0}%"></div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="detail-section status">
                    <h4>Current Status</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <strong>Current Step:</strong>
                            <span>${operation.current_step || 'Not specified'}</span>
                        </div>
                        <div class="detail-item">
                            <strong>Steps Completed:</strong>
                            <span>${operation.steps_completed || 0} / ${operation.steps_total || 'Unknown'}</span>
                        </div>
                    </div>
                </div>
                
                <div class="detail-section timing">
                    <h4>Timing</h4>
                    <div class="detail-grid">
                        <div class="detail-item">
                            <strong>Created:</strong>
                            <span>${createdTime}</span>
                        </div>
                        <div class="detail-item">
                            <strong>Last Updated:</strong>
                            <span>${updatedTime} (${timeText})</span>
                        </div>
                    </div>
                </div>
                
                ${operation.error_message ? `
                <div class="detail-section">
                    <h4>Error Details</h4>
                    <div class="error-message">
                        <pre>${operation.error_message}</pre>
                    </div>
                </div>
                ` : ''}
                
                ${operation.result_data ? `
                <div class="detail-section">
                    <h4>Result Data</h4>
                    <div class="result-data">
                        <pre>${JSON.stringify(JSON.parse(operation.result_data), null, 2)}</pre>
                    </div>
                </div>
                ` : ''}
                
                <div class="detail-section logs">
                    <h4>Operation Logs</h4>
                    <div id="operationLogs" class="logs-container">
                        <div class="loading">Loading logs...</div>
                    </div>
                    <div class="logs-controls">
                        <button onclick="refreshOperationLogs('${operation.operation_id}')" class="btn btn-primary">🔄 Refresh Logs</button>
                        <button onclick="toggleAutoRefresh()" class="btn btn-secondary" id="autoRefreshBtn">⏸️ Auto Refresh</button>
                    </div>
                </div>
            </div>
        `;
        
        // Load logs immediately
        loadOperationLogs(operation.operation_id);
    } catch (error) {
        content.innerHTML = `
            <div class="error">
                <h4>Error Loading Operation Details</h4>
                <p>${error.message}</p>
            </div>
        `;
    }
}

window.closeOperationDetailModal = function closeOperationDetailModal() {
    document.getElementById('operationDetailModal').style.display = 'none';
}

// Research status modal functions
window.showResearchStatus = async function showResearchStatus() {
    const modal = document.getElementById('researchStatusModal');
    const content = document.getElementById('researchStatusContent');
    
    modal.style.display = 'block';
    content.innerHTML = '<div class="loading">Loading research status...</div>';
    
    try {
        const response = await fetch('/research/status');
        if (!response.ok) {
            throw new Error(`Failed to load research status: ${response.status}`);
        }
        
        const statusHtml = await response.text();
        content.innerHTML = statusHtml;
    } catch (error) {
        content.innerHTML = `
            <div class="error">
                <h4>Error Loading Research Status</h4>
                <p>${error.message}</p>
            </div>
        `;
    }
}

window.closeResearchStatusModal = function closeResearchStatusModal() {
    document.getElementById('researchStatusModal').style.display = 'none';
}

window.refreshResearchStatus = function refreshResearchStatus() {
    showResearchStatus();
}

// Operation logs functionality
let autoRefreshInterval = null;
let currentOperationId = null;

window.loadOperationLogs = async function loadOperationLogs(operationId) {
    currentOperationId = operationId;
    const logsContainer = document.getElementById('operationLogs');
    
    try {
        const response = await fetch(`/api/operations/${operationId}/logs`);
        if (!response.ok) {
            throw new Error(`Failed to load logs: ${response.status}`);
        }
        
        const data = await response.json();
        displayLogs(data.logs);
    } catch (error) {
        logsContainer.innerHTML = `
            <div class="error">
                <h4>Error Loading Logs</h4>
                <p>${error.message}</p>
            </div>
        `;
    }
}

window.refreshOperationLogs = function refreshOperationLogs(operationId) {
    loadOperationLogs(operationId);
}

window.toggleAutoRefresh = function toggleAutoRefresh() {
    const btn = document.getElementById('autoRefreshBtn');
    
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        btn.textContent = '▶️ Auto Refresh';
        btn.classList.remove('active');
    } else {
        if (currentOperationId) {
            autoRefreshInterval = setInterval(() => {
                loadOperationLogs(currentOperationId);
            }, 2000); // Refresh every 2 seconds
            btn.textContent = '⏸️ Auto Refresh';
            btn.classList.add('active');
        }
    }
}

function displayLogs(logs) {
    const logsContainer = document.getElementById('operationLogs');
    
    if (!logs || logs.length === 0) {
        logsContainer.innerHTML = '<div class="no-logs">No logs available for this operation.</div>';
        return;
    }
    
    const logsHtml = logs.map(log => {
        const timeAgo = log.timeAgo < 60 ? `${log.timeAgo}s ago` : 
            log.timeAgo < 3600 ? `${Math.round(log.timeAgo / 60)}m ago` : 
            `${Math.round(log.timeAgo / 3600)}h ago`;
        
        const detailsHtml = log.details ? 
            `<div class="log-details"><pre>${JSON.stringify(log.details, null, 2)}</pre></div>` : '';
        
        return `
            <div class="log-entry log-${log.level}">
                <div class="log-header">
                    <span class="log-level">${log.level.toUpperCase()}</span>
                    <span class="log-time">${timeAgo}</span>
                </div>
                <div class="log-message">${log.message}</div>
                ${detailsHtml}
            </div>
        `;
    }).join('');
    
    logsContainer.innerHTML = logsHtml;
}

// Close modal when clicking outside
window.onclick = function(event) {
    const researchModal = document.getElementById('researchModal');
    const operationModal = document.getElementById('operationDetailModal');
    const researchStatusModal = document.getElementById('researchStatusModal');
    
    if (event.target === researchModal) {
        closeResearchModal();
    } else if (event.target === operationModal) {
        closeOperationDetailModal();
    } else if (event.target === researchStatusModal) {
        closeResearchStatusModal();
    } else if (event.target === repoAnalysisModal) {
        closeRepoModal();
    }
}

// Repository Analysis Modal Functions
let currentRepoFullName = '';

function openRepoModal(repoFullName) {
    currentRepoFullName = repoFullName;
    const modal = document.getElementById('repoAnalysisModal');
    const title = document.getElementById('repoModalTitle');
    const content = document.getElementById('repoAnalysisContent');
    
    title.textContent = `Analysis: ${repoFullName}`;
    content.innerHTML = '<div class="loading">Loading repository analysis...</div>';
    
    modal.style.display = 'block';
    
    // Load analysis data
    loadRepoAnalysis(repoFullName);
}

function closeRepoModal() {
    const modal = document.getElementById('repoAnalysisModal');
    modal.style.display = 'none';
    currentRepoFullName = '';
}

function loadRepoAnalysis(repoFullName) {
    const [owner, repo] = repoFullName.split('/');
    const url = `/api/repo/${owner}/${repo}/analysis`;
    
    fetch(url)
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                document.getElementById('repoAnalysisContent').innerHTML = 
                    `<div class="error">Error: ${data.error}</div>`;
                return;
            }
            
            renderRepoAnalysis(data);
        })
        .catch(error => {
            console.error('Error loading repo analysis:', error);
            document.getElementById('repoAnalysisContent').innerHTML = 
                `<div class="error">Failed to load analysis: ${error.message}</div>`;
        });
}

function renderRepoAnalysis(data) {
    const { analysis, badges, commands } = data;
    
    const badgesHtml = badges.map(badge => 
        `<span class="badge" style="background-color: ${badge.color}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; margin-right: 6px; display: inline-block;">${badge.label}</span>`
    ).join('');
    
    const commandsHtml = commands.map(cmd => `
        <div class="command-item" style="margin-bottom: 15px; padding: 12px; background: #f6f8fa; border-radius: 6px; border-left: 4px solid #0366d6;">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                <h4 style="margin: 0; color: #24292e;">${cmd.title}</h4>
                <span class="priority-badge" style="background: ${cmd.priority === 'high' ? '#d73a49' : cmd.priority === 'medium' ? '#f66a0a' : '#6a737d'}; color: white; padding: 2px 6px; border-radius: 10px; font-size: 10px; text-transform: uppercase;">${cmd.priority}</span>
            </div>
            <p style="margin: 0 0 8px 0; color: #586069; font-size: 14px;">${cmd.description}</p>
            ${cmd.command ? `<code style="background: #e1e4e8; padding: 4px 6px; border-radius: 3px; font-family: monospace; font-size: 12px; display: block; margin-top: 8px;">${cmd.command}</code>` : ''}
            ${cmd.url ? `<a href="${cmd.url}" target="_blank" style="color: #0366d6; text-decoration: none; font-size: 12px;">Open Link →</a>` : ''}
        </div>
    `).join('');
    
    const bestPracticesHtml = analysis.bestPractices.map(practice => `
        <div class="practice-item" style="margin-bottom: 12px; padding: 10px; background: #f0f9ff; border-radius: 6px; border-left: 4px solid #10b981;">
            <h4 style="margin: 0 0 6px 0; color: #065f46; font-size: 14px;">${practice.title}</h4>
            <p style="margin: 0; color: #047857; font-size: 13px;">${practice.description}</p>
            <div style="margin-top: 6px; font-size: 11px; color: #6b7280;">
                Confidence: ${Math.round(practice.confidence * 100)}% | Category: ${practice.category}
            </div>
        </div>
    `).join('');
    
    document.getElementById('repoAnalysisContent').innerHTML = `
        <div class="repo-analysis">
            <!-- Summary Section -->
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">📋 Summary</h3>
                <p style="color: #586069; line-height: 1.5;">${analysis.summary}</p>
                <div style="margin-top: 10px;">
                    ${badgesHtml}
                </div>
            </div>
            
            <!-- Key Highlights -->
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">✨ Key Highlights</h3>
                <ul style="color: #586069; padding-left: 20px;">
                    ${analysis.keyHighlights.map(highlight => `<li style="margin-bottom: 4px;">${highlight}</li>`).join('')}
                </ul>
            </div>
            
            <!-- Technology Stack -->
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">🛠️ Technology Stack</h3>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                    ${analysis.technologyStack.map(tech => `<span style="background: #e1e4e8; padding: 4px 8px; border-radius: 12px; font-size: 12px; color: #24292e;">${tech}</span>`).join('')}
                </div>
            </div>
            
            <!-- Architecture -->
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">🏗️ Architecture</h3>
                <p style="color: #586069; line-height: 1.5;">${analysis.architecture}</p>
            </div>
            
            <!-- Strengths & Weaknesses -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                <div class="analysis-section">
                    <h3 style="color: #10b981; margin-bottom: 10px;">✅ Strengths</h3>
                    <ul style="color: #586069; padding-left: 20px;">
                        ${analysis.strengths.map(strength => `<li style="margin-bottom: 4px;">${strength}</li>`).join('')}
                    </ul>
                </div>
                <div class="analysis-section">
                    <h3 style="color: #ef4444; margin-bottom: 10px;">⚠️ Areas for Improvement</h3>
                    <ul style="color: #586069; padding-left: 20px;">
                        ${analysis.weaknesses.map(weakness => `<li style="margin-bottom: 4px;">${weakness}</li>`).join('')}
                    </ul>
                </div>
            </div>
            
            <!-- Action Commands -->
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">🚀 Quick Actions</h3>
                ${commandsHtml}
            </div>
            
            <!-- Best Practices -->
            ${bestPracticesHtml ? `
            <div class="analysis-section" style="margin-bottom: 20px;">
                <h3 style="color: #24292e; margin-bottom: 10px;">📚 Best Practices</h3>
                ${bestPracticesHtml}
            </div>
            ` : ''}
            
            <!-- Analysis Metadata -->
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #e1e4e8; font-size: 12px; color: #6b7280;">
                Analysis confidence: ${Math.round(analysis.confidence * 100)}% | 
                Generated: ${new Date(analysis.analysisTimestamp).toLocaleString()}
            </div>
        </div>
    `;
}

function recordFeedback(feedback) {
    if (!currentRepoFullName) return;
    
    const [owner, repo] = currentRepoFullName.split('/');
    const url = `/api/repo/${owner}/${repo}/feedback`;
    
    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            feedback: feedback,
            reasoning: `User ${feedback}d this repository`
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Update button states
            const thumbsUp = document.getElementById('thumbsUp');
            const thumbsDown = document.getElementById('thumbsDown');
            
            if (feedback === 'like') {
                thumbsUp.style.background = '#10b981';
                thumbsUp.textContent = '👍 Liked!';
                thumbsDown.style.background = '#6b7280';
                thumbsDown.textContent = '👎 Dislike';
            } else {
                thumbsDown.style.background = '#ef4444';
                thumbsDown.textContent = '👎 Disliked!';
                thumbsUp.style.background = '#6b7280';
                thumbsUp.textContent = '👍 Like';
            }
            
            // Show feedback confirmation
            const confirmation = document.createElement('div');
            confirmation.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #10b981; color: white; padding: 10px 15px; border-radius: 6px; z-index: 1000; font-size: 14px;';
            confirmation.textContent = `Feedback recorded! Thank you for helping improve recommendations.`;
            document.body.appendChild(confirmation);
            
            setTimeout(() => {
                document.body.removeChild(confirmation);
            }, 3000);
        }
    })
    .catch(error => {
        console.error('Error recording feedback:', error);
    });
}
