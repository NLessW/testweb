//
// ========== 호스팅 땐 console.log 주석 처리나 제거 ==========
const loginButton = document.getElementById('login-button');
const loginPopup = document.getElementById('login-popup');
const loginSubmit = document.getElementById('login-submit');
const phoneNumberInput = document.getElementById('phone-number');
const processMessage = document.getElementById('process-message');
const stopButton = document.getElementById('stop-button');
const returnHomeButton = document.getElementById('return-home');
const keypad = document.querySelector('.keypad');
const addMoreButton = document.getElementById('add-more-button');
const mainScreen = document.getElementById('main-screen');
const processScreen = document.getElementById('process-screen');
const endScreen = document.getElementById('end-screen');
const errorScreen = document.getElementById('error-screen');
const statusHostMain = document.getElementById('status-host-main');
const statusHostProcess = document.getElementById('status-host-process');
const statusSection = document.getElementById('status-section');
const branchNameSpan = document.getElementById('branch-name');

const closeDoorButton = document.createElement('button');
closeDoorButton.id = 'close-door-button';
closeDoorButton.textContent = '닫힘';
closeDoorButton.style =
    'margin-top:24px;font-size:1.5rem;padding:12px 32px;background:#3772ff;color:#fff;border:none;border-radius:8px;cursor:pointer;display:block;';

let port, reader, writer;
let isConnected = false;
let isStopped = false;
let autoReturnTimeout;
let countdownInterval;
let errorAutoTimer;
let errorCountdownTimer;
// 테스트 모드 상태
let __testMode = false;
let __simQueue = [];
let __simPaused = false;

function updateTestBadge() {
    const b = document.getElementById('test-mode-badge');
    if (!b) return;
    if (__testMode) {
        b.textContent = '테스트모드: ON';
        b.style.color = '#86efac';
    } else {
        b.textContent = '테스트모드: OFF';
        b.style.color = '#fca5a5';
    }
}

function simEnqueue(text, delay = 0) {
    __simQueue.push({ text, delay });
}

function installSimulator() {
    // 가짜 reader
    reader = {
        async read() {
            if (!__testMode) return { value: '', done: true };
            if (__simPaused) {
                await new Promise((r) => setTimeout(r, 100));
                return { value: '', done: false };
            }
            if (__simQueue.length === 0) {
                await new Promise((r) => setTimeout(r, 120));
                return { value: '', done: false };
            }
            const item = __simQueue.shift();
            if (item.delay) await new Promise((r) => setTimeout(r, item.delay));
            return { value: item.text + '\n', done: false };
        },
        releaseLock() {},
        cancel() {
            __simPaused = true;
        },
    };
    // 가짜 writer
    writer = {
        async write(data) {
            if (!__testMode) return;
            const cmd = String(data).trim();
            // 명령에 따라 가짜 응답 시뮬레이션
            if (cmd === '99') {
                // pre-start
                simEnqueue('Ready');
            } else if (cmd === '1') {
                simEnqueue('Door will open', 300);
                simEnqueue('Motor stopped.', 800);
            } else if (cmd === '2') {
                simEnqueue('Door closed successfully!', 700);
            } else if (cmd === '3') {
                simEnqueue('Motor task completed!', 1200);
            } else if (cmd === '4') {
                simEnqueue('24V Motor stopped.', 1500);
            } else if (cmd === 'X') {
                simEnqueue('Motor stopped.', 300);
            }
        },
        releaseLock() {},
    };
    isConnected = true;
    // UI 상태 갱신
    const arduinoStatus = document.getElementById('arduino-status');
    const machineStatus = document.getElementById('machine-status');
    if (arduinoStatus) {
        arduinoStatus.textContent = '시뮬레이터';
        arduinoStatus.style.color = '#00ff4c';
    }
    if (machineStatus) {
        machineStatus.textContent = '가능(테스트)';
        machineStatus.style.color = '#00ff4c';
    }
    if (loginButton) {
        loginButton.disabled = false;
        loginButton.textContent = '시작하기';
    }
}

// 장치 분리(케이블 탈거 등) 발생 시 공통 처리
async function teardownSerial() {
    try {
        if (reader) {
            try {
                await reader.cancel?.();
            } catch {}
            try {
                reader.releaseLock?.();
            } catch {}
        }
        if (writer) {
            try {
                writer.releaseLock?.();
            } catch {}
        }
        if (port) {
            try {
                await port.close();
            } catch {}
        }
    } finally {
        port = undefined;
        reader = undefined;
        writer = undefined;
        isConnected = false;
    }
}

function handleDeviceLost(err) {
    const msg = String((err && (err.message || err)) || '').toLowerCase();
    const lost = msg.includes('device has been lost');
    const networkErr = err && err.name === 'NetworkError';
    if (lost || networkErr) {
        // 연결 해제 및 사용자 안내
        teardownSerial();
        showErrorScreen('기기와의 연결이 끊어졌습니다.\n관리자에게 문의 바랍니다. 1644-1224');
        return true;
    }
    return false;
}

// 아두이노는 줄 단위 명령 처리 -> 항상 \n 포함
function writeCmd(cmd) {
    if (__testMode) {
        // 시뮬레이터 writer에 위임
        return writer && writer.write ? writer.write(cmd + '\n') : Promise.resolve();
    }
    if (!writer) return Promise.resolve();
    try {
        return writer.write(cmd + '\n');
    } catch (e) {
        console.error('writeCmd 실패:', cmd, e);
        return Promise.reject(e);
    }
}

// Removed Firebase initialization and database usage
let currentPhoneNumber = '';
let deviceConfig = { deviceCode: undefined, branchName: undefined };

// ====== 로컬 ini 파일(C:\\petmon.ini)에서 지점명/기기코드 읽기 ======
// 보안 제한으로 브라우저에서 임의 경로 파일을 직접 읽을 수 없습니다.
// 대신, index.html과 동일한 오리진에서 petmon.ini를 정적 제공하거나(권장, 루트에 배치),
// kiosk 브라우저/로컬 서버(예: http-server)로 C:\\petmon.ini를 프록시해주세요.
// 아래 로직은 두 위치를 순차 시도합니다.
//  1) /petmon.ini (서비스 루트)
//  2) /config/petmon.ini (서브 경로 예시)
// INI 포맷 예:
//   device=SW0001
//   branch=홍대점
async function loadDeviceConfig() {
    // 0) URL 파라미터 우선 사용 (?branch=홍대점&device=SW0001)
    try {
        const params = new URLSearchParams(window.location.search || '');
        const pBranch = params.get('branch');
        const pDevice = params.get('device');
        if (pBranch || pDevice) {
            deviceConfig = {
                deviceCode: pDevice || deviceConfig.deviceCode,
                branchName: pBranch || deviceConfig.branchName,
            };
            // UI 반영
            if (deviceConfig.branchName && branchNameSpan) branchNameSpan.textContent = deviceConfig.branchName;
            // 저장(영구화)
            if (pBranch) localStorage.setItem('petmon.branch', deviceConfig.branchName || '');
            if (pDevice) localStorage.setItem('petmon.device', deviceConfig.deviceCode || '');
            return;
        }
    } catch {}

    // 1) localStorage 저장값 사용
    try {
        const lsBranch = localStorage.getItem('petmon.branch');
        const lsDevice = localStorage.getItem('petmon.device');
        if (lsBranch || lsDevice) {
            deviceConfig = {
                deviceCode: lsDevice || deviceConfig.deviceCode,
                branchName: lsBranch || deviceConfig.branchName,
            };
            if (deviceConfig.branchName && branchNameSpan) branchNameSpan.textContent = deviceConfig.branchName;
            return;
        }
    } catch {}

    // 2) window.PETMON_CONFIG 사용 (서버/파일 없이 동작)
    try {
        if (window && window.PETMON_CONFIG) {
            const cfg = window.PETMON_CONFIG || {};
            deviceConfig = {
                deviceCode: cfg.deviceCode,
                branchName: cfg.branchName,
            };
            if (deviceConfig.branchName && branchNameSpan) {
                branchNameSpan.textContent = deviceConfig.branchName;
                return;
            }
        }
    } catch {}

    // 3) 같은 오리진에서 제공되는 ini 파일 시도
    const candidates = ['/petmon.ini', '/config/petmon.ini'];
    for (const url of candidates) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const text = await res.text();
            const lines = text.split(/\r?\n/);
            const out = { deviceCode: undefined, branchName: undefined };
            for (const raw of lines) {
                const line = raw.trim();
                if (!line || line.startsWith('#') || line.startsWith(';')) continue;
                const m = line.match(/^([^=:#]+)\s*[:=]\s*(.*)$/);
                if (!m) continue;
                const key = m[1].trim().toLowerCase();
                const val = m[2].trim();
                if (key === 'device' || key === 'devicecode' || key === 'code') out.deviceCode = val;
                if (key === 'branch' || key === 'branchname' || key === 'name') out.branchName = val;
            }
            if (out.branchName) {
                deviceConfig = out;
                if (branchNameSpan) branchNameSpan.textContent = out.branchName;
                return;
            }
        } catch (e) {
            // 다음 후보로 진행
        }
    }
    // 실패 시 기본 라벨 제거
    if (branchNameSpan) branchNameSpan.textContent = '';
}

// ====== (선택) 파일 선택 대화로 C:\\petmon.ini 불러오기 ======
// 브라우저 보안 정책상 자동 접근은 불가하지만, 사용자의 명시적 동작(키 입력/클릭)으로는 가능.
// 단축키: Ctrl+Alt+I 누르면 파일 선택 창이 열리고 ini를 파싱해서 적용/저장합니다.
function parseIniText(text) {
    const out = { deviceCode: undefined, branchName: undefined };
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
        const line = (raw || '').trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const m = line.match(/^([^=:#]+)\s*[:=]\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (key === 'device' || key === 'devicecode' || key === 'code') out.deviceCode = val;
        if (key === 'branch' || key === 'branchname' || key === 'name') out.branchName = val;
    }
    return out;
}

async function pickAndLoadIni() {
    if (!window.showOpenFilePicker) {
        alert('이 브라우저는 파일 선택 API를 지원하지 않습니다. Chrome/Edge 최신 버전을 사용해주세요.');
        return;
    }
    try {
        const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [
                {
                    description: 'INI files',
                    accept: { 'text/plain': ['.ini', '.txt'] },
                },
            ],
            excludeAcceptAllOption: false,
        });
        const file = await handle.getFile();
        const text = await file.text();
        const parsed = parseIniText(text);
        if (!parsed.branchName && !parsed.deviceCode) {
            alert('유효한 ini 형식이 아닙니다. (예: device=SW0001, branch=홍대점)');
            return;
        }
        deviceConfig = parsed;
        if (branchNameSpan && parsed.branchName) branchNameSpan.textContent = parsed.branchName;
        try {
            if (parsed.branchName) localStorage.setItem('petmon.branch', parsed.branchName);
            if (parsed.deviceCode) localStorage.setItem('petmon.device', parsed.deviceCode);
        } catch {}
        alert('설정이 적용되었습니다.');
    } catch (e) {
        // 사용자가 취소한 경우 등은 무시
        console.debug('INI 선택 취소 또는 오류:', e);
    }
}

// 전역에 노출(핫키에서 호출)
if (typeof window !== 'undefined') {
    window.pickAndLoadIni = pickAndLoadIni;
}

// 투입 횟수 누적 및 최종 처리 상태
let depositCount = 0;
let isFinalizing = false;
// 마지막 포인트 API 호출 정보 (중복 호출 방지 및 요약 표시)
let lastPointApi = { mobile: null, count: 0, result: null };

// ====== OPFS 기반 포인트 결과 로그 ======
async function appendPointLog(line) {
    try {
        if (!navigator?.storage?.getDirectory) return; // 지원 안하면 무시
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('petmon', { create: true });
        const file = await dir.getFileHandle('point_log.txt', { create: true });
        const existing = await file.getFile();
        const writer = await file.createWritable({ keepExistingData: true });
        try {
            await writer.seek(existing.size);
            await writer.write(line + '\n');
        } finally {
            await writer.close();
        }
    } catch (e) {
        console.debug('appendPointLog failed (ignored):', e);
    }
}
function nowTs() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes()) +
        ':' +
        pad(d.getSeconds())
    );
}

// 포인트 적립 API 호출
async function callPointApi(mobileWithHyphens, count) {
    if (__testMode) {
        // 테스트 모드에선 바로 성공 응답 시뮬레이트
        return Promise.resolve({ status: 'ok', test: true, mobile: mobileWithHyphens, input_cnt: count });
    }
    const apiUrl = 'https://petcycle.mycafe24.com/point_api.php';
    const mobile = (mobileWithHyphens || '').replace(/[^0-9]/g, '');
    const payload = {
        device: deviceConfig.deviceCode || 'SW0001',
        mobile: mobile,
        input_cnt: Number(count),
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                Accept: 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const text = await response.text(); // 일부 응답이 JSON이 아닐 수 있으므로 먼저 text로 받음
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = text; // 파싱 실패 시 원문 텍스트 보존
        }

        if (!response.ok) {
            // 서버가 에러 메시지를 JSON으로 보냈다면 그 메시지를 사용
            const errMsg = parsed && parsed.message ? parsed.message : `HTTP 오류: ${response.status}`;
            throw new Error(errMsg);
        }

        return parsed;
    } catch (error) {
        console.error('포인트 API 호출 실패:', error);
        throw error;
    }
}

// 누적 투입 횟수로 API 호출 후 메인으로 복귀
async function finalizeAndReturnHome() {
    if (isFinalizing) return;
    isFinalizing = true;
    let result = null;
    try {
        if (currentPhoneNumber && depositCount > 0) {
            result = await callPointApi(currentPhoneNumber, depositCount);
            if (result && result.status === 'error') {
                // 실패 응답 로그
                const logLineErr = `[${nowTs()}] RESULT=ERROR device=${
                    deviceConfig.deviceCode || 'UNKNOWN'
                } mobile=${currentPhoneNumber} count=${depositCount} msg=${
                    (result && (result.message || result)) || ''
                }`;
                appendPointLog(logLineErr);
                console.error('포인트 API 응답 오류:', result.message || result);
            } else {
                // 성공 로그
                const logLineOk = `[${nowTs()}] RESULT=OK device=${
                    deviceConfig.deviceCode || 'UNKNOWN'
                } mobile=${currentPhoneNumber} count=${depositCount} raw=${JSON.stringify(result)}`;
                appendPointLog(logLineOk);
                console.log('포인트 적립 결과:', result);
            }
        }
    } catch (err) {
        // 예외 로그
        const logLineEx = `[${nowTs()}] RESULT=EXCEPTION device=${
            deviceConfig.deviceCode || 'UNKNOWN'
        } mobile=${currentPhoneNumber} count=${depositCount} error=${(err && (err.message || err)) || ''}`;
        appendPointLog(logLineEx);
        console.error('포인트 적립 중 예외 발생:', err);
    } finally {
        // 화면 및 상태 초기화
        depositCount = 0;
        showScreen('main-screen');
        isFinalizing = false;
    }
}

// ========== 화면 전환 ==========
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach((s) => (s.style.display = 'none'));
    document.getElementById(screenId).style.display = 'flex';

    // 상태 패널 위치 이동: 프로세스 중엔 오른쪽, 그 외엔 메인 위치
    if (statusSection && statusHostMain && statusHostProcess) {
        if (screenId === 'process-screen') {
            statusHostProcess.appendChild(statusSection);
        } else {
            statusHostMain.appendChild(statusSection);
        }
    }

    if (screenId === 'end-screen') {
        let countdown = 10;
        const endScreen = document.getElementById('end-screen');
        endScreen.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;">
                <div style="margin-bottom:24px;">
                    <img src="${ICONS.success}" alt="success" width="100" height="100"/>
                </div>
                <div style="font-size:2.4rem;font-weight:bold;color:#3772ff;margin-bottom:12px;">
                    포인트 적립 중...
                </div>
                <div id="end-details" style="font-size:1.2rem;color:#e8eefc;margin-bottom:8px;text-align:center;"></div>
                <div id="end-summary" style="font-size:1.4rem;color:#ffffff;margin-bottom:16px;text-align:center;"></div>
                <div style="font-size:1.1rem;color:#dbe6ff;margin-bottom:24px;text-align:center;">
                    참여해주셔서 감사합니다.<br>
                    <span id="end-countdown" style="color:#fff;font-weight:bold;">${countdown}</span>초 뒤 처음 화면으로 돌아갑니다.
                </div>
                <button id="add-more-button" style="font-size:1.2rem;padding:10px 28px;background:#3772ff;color:#fff;border:none;border-radius:8px;cursor:pointer;margin-bottom:12px;" disabled>
                    페트병 더 넣기
                </button>
                <button id="return-home" style="font-size:1.2rem;padding:10px 28px;background:#fff;color:#3772ff;border:2px solid #3772ff;border-radius:8px;cursor:pointer;" disabled>
                    처음 화면으로
                </button>
            </div>
        `;
        // 카운트다운(버튼 활성화 이후에도 유지)
        const countdownText = document.getElementById('end-countdown');
        countdownInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) {
                countdownText.textContent = countdown;
            } else clearInterval(countdownInterval);
        }, 1000);

        // 즉시 포인트 API 호출하여 요약 표시
        (async () => {
            const details = document.getElementById('end-details');
            const summary = document.getElementById('end-summary');
            const btnMore = document.getElementById('add-more-button');
            const btnHome = document.getElementById('return-home');
            try {
                const m = currentPhoneNumber;
                const cnt = depositCount;
                details.textContent = `방금 투입한 개수: ${cnt}개`;

                let res = null;
                if (m && cnt > 0) {
                    res = await callPointApi(m, cnt);
                    lastPointApi = { mobile: m, count: cnt, result: res };

                    // 성공/형식별 처리
                    const data = res?.data || res; // 서버 형식 또는 단순 테스트 형식
                    const inputCnt = Number(data?.input_cnt ?? cnt);
                    const inputPoint = Number(data?.input_point ?? inputCnt * 10);
                    const totalPoint = data?.total_point;

                    // 성공 로그
                    const logLineOk = `[${nowTs()}] RESULT=OK device=${
                        deviceConfig.deviceCode || 'UNKNOWN'
                    } mobile=${m} count=${cnt} raw=${JSON.stringify(res)}`;
                    appendPointLog(logLineOk);

                    summary.innerHTML = `
                        <div><strong>${inputPoint}포인트</strong>가 적립되었습니다.</div>
                        ${totalPoint != null ? `<div>현재 보유 포인트: <strong>${totalPoint}</strong>점</div>` : ''}
                    `;
                } else {
                    summary.textContent = '전화번호 또는 투입 수량이 없어 적립을 진행하지 않았습니다.';
                }
            } catch (err) {
                // 예외 로그
                const logLineEx = `[${nowTs()}] RESULT=EXCEPTION device=${
                    deviceConfig.deviceCode || 'UNKNOWN'
                } mobile=${currentPhoneNumber} count=${depositCount} error=${(err && (err.message || err)) || ''}`;
                appendPointLog(logLineEx);
                summary.innerHTML = `<span style="color:#ffb3b3;">포인트 적립 중 오류가 발생했습니다. 나중에 다시 시도해주세요.</span>`;
                console.error('포인트 적립 중 예외 발생(End Screen):', err);
            } finally {
                // 적립이 처리되었다면 이후 중복 적립 방지 위해 카운트 리셋
                // 단, 실패한 경우에는 리셋하지 않음 (귀가 시 재시도 목적)
                if (lastPointApi?.result) {
                    depositCount = 0;
                }
                if (btnMore) btnMore.disabled = false;
                if (btnHome) btnHome.disabled = false;

                // 자동 복귀 타이머 시작 (버튼 활성화 후에도 동작)
                autoReturnTimeout = setTimeout(() => {
                    finalizeAndReturnHome();
                }, 10000);
            }
        })();

        // 버튼 이벤트 재연결
        document.getElementById('add-more-button').onclick = async () => {
            clearTimeout(autoReturnTimeout);
            clearInterval(countdownInterval);
            await startProcess();
        };
        document.getElementById('return-home').onclick = () => {
            clearTimeout(autoReturnTimeout);
            clearInterval(countdownInterval);
            finalizeAndReturnHome();
        };
    } else {
        clearTimeout(autoReturnTimeout);
        clearInterval(countdownInterval);
    }

    // 메인화면으로 돌아갈 때 아두이노에 'X' 신호 전송 및 세션 초기화
    if (screenId === 'main-screen') {
        if (writer) {
            try {
                writeCmd('X');
            } catch (e) {
                console.error('아두이노로 X 신호 전송 실패:', e);
            }
        }
        phoneNumberInput.value = '';
        currentPhoneNumber = '';
        depositCount = 0; // 세션 종료 시 카운트 초기화
        const fill = document.getElementById('process-progress-fill');
        if (fill) fill.style.width = '0%';
        // stepper removed; nothing to reset
    }
}

// 오류 화면 표시 및 점검 모드 전환
function showErrorScreen(message) {
    try {
        clearTimeout(errorAutoTimer);
        clearInterval(errorCountdownTimer);
    } catch {}
    // 유지보수 모드 진입 및 주기 체크 중단
    if (window) {
        window.__maintenanceMode = true;
        if (window.stopPeriodicStatusCheck) {
            window.stopPeriodicStatusCheck();
        }
    }
    // 상태를 점검중으로 표시
    const arduinoStatus = document.getElementById('arduino-status');
    const machineStatus = document.getElementById('machine-status');
    if (arduinoStatus) {
        arduinoStatus.textContent = '점검중';
        arduinoStatus.style.color = '#ff4d4d';
    }
    if (machineStatus) {
        machineStatus.textContent = '점검중';
        machineStatus.style.color = '#ff4d4d';
    }
    // 로그인 버튼 비활성화 및 라벨 변경
    if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = '점검중';
    }

    const msgEl = document.getElementById('error-message');
    if (msgEl) msgEl.textContent = message || '기기 오류가 발생했습니다. 관리자에게 문의해주세요.';
    const phoneEl = document.getElementById('error-phone');
    if (phoneEl) phoneEl.textContent = `입력한 전화번호: ${currentPhoneNumber || '-'}`;
    showScreen('error-screen');

    const callBtn = document.getElementById('call-support');
    if (callBtn) {
        callBtn.onclick = () => {
            try {
                window.location.href = 'tel:1644-1224';
            } catch {
                alert('고객센터 전화번호: 1644-1224');
            }
        };
    }
    const ret = document.getElementById('error-return-home');
    if (ret) {
        ret.onclick = () => {
            clearTimeout(errorAutoTimer);
            clearInterval(errorCountdownTimer);
            showScreen('main-screen');
        };
    }

    // 10초 카운트다운 후 메인으로
    let sec = 10;
    const cd = document.getElementById('error-countdown');
    if (cd) cd.textContent = '10초 뒤 처음 화면으로 돌아가며, 장비 상태는 점검중으로 전환됩니다.';
    errorCountdownTimer = setInterval(() => {
        sec--;
        if (cd) cd.textContent = `${sec}초 뒤 처음 화면으로 돌아가며, 장비 상태는 점검중으로 전환됩니다.`;
        if (sec <= 0) clearInterval(errorCountdownTimer);
    }, 1000);
    errorAutoTimer = setTimeout(() => {
        showScreen('main-screen');
    }, 10000);
}

// ========== 프로세스 실행 ==========
// 외부 SVG 아이콘(URL) 사용: 더 직관적인 상태 아이콘
const ICONS = {
    // 상태/단계
    openDoor: 'https://api.iconify.design/mdi/door-open.svg?color=%233772ff&width=90&height=90',
    closeDoor: 'https://api.iconify.design/mdi/door-closed.svg?color=%23ff6b6b&width=90&height=90',
    label: 'https://api.iconify.design/mdi/label-outline.svg?color=%233772ff&width=90&height=90',
    scan: 'https://api.iconify.design/mdi/magnify.svg?color=%233772ff&width=90&height=90',
    collect: 'https://api.iconify.design/mdi/recycle-variant.svg?color=%233772ff&width=90&height=90',
    // 피드백/알림
    success: 'https://api.iconify.design/mdi/check-circle-outline.svg?color=%233772ff&width=100&height=100',
    warn: 'https://api.iconify.design/mdi/alert-circle-outline.svg?color=%23ff4d4d&width=90&height=90',
    hand: 'https://api.iconify.design/mdi/hand-back-right.svg?color=%23ff4d4d&width=90&height=90',
    stop: 'https://api.iconify.design/mdi/cog.svg?color=%233772ff&width=90&height=90',
};

// 단계별 배경색 (선택)
const processBgColors = [
    '#e3f0ff', // 문 열림
    '#ffeaea', // 문 닫힘/손조심
    '#f0f6ff', // 판별중
    '#f3f7ff', // 수집중
];

// 공통 렌더러: 아이콘 + 메시지 + 배경
function renderProcess(iconKey, message, bgIndex, { spin = false, iconAlt = '' } = {}) {
    try {
        const iconUrl = ICONS[iconKey] || ICONS.scan;
        const spinClass = spin ? 'spin' : '';
        const accent =
            iconKey === 'openDoor'
                ? 'open'
                : iconKey === 'closeDoor'
                  ? 'close'
                  : iconKey === 'scan'
                    ? 'scan'
                    : iconKey === 'collect'
                      ? 'collect'
                      : iconKey === 'hand'
                        ? 'warn'
                        : iconKey === 'stop'
                          ? 'stop'
                          : 'label';

        const iconHtml =
            iconKey === 'label'
                ? `<svg width="90" height="90" viewBox="0 0 90 90" fill="none" aria-hidden="true">
                                 <circle cx="45" cy="45" r="14" fill="#ffffff" stroke="#3772ff" stroke-width="4"/>
                                 <!-- 위: 세로로 긴 삼각형(아래로 향함) -->
                                 <polygon points="40,18 50,18 45,38" fill="#f59e0b" stroke="#fbbf24" stroke-width="2"/>
                                 <!-- 아래: 세로로 긴 삼각형(위로 향함) -->
                                 <polygon points="40,72 50,72 45,52" fill="#f59e0b" stroke="#fbbf24" stroke-width="2"/>
                             </svg>`
                : `<img src="${iconUrl}" alt="${iconAlt || ''}" width="90" height="90"/>`;
        processMessage.innerHTML = `
            <div class="process-hero accent-${accent}">
                <div class="icon-bubble ${spinClass}">${iconHtml}</div>
                <div class="process-title">${message}</div>
            </div>
        `;
        const box = document.querySelector('.process-box');
        if (box) {
            box.classList.remove(
                'theme-open',
                'theme-close',
                'theme-scan',
                'theme-collect',
                'theme-label',
                'theme-warn',
                'theme-stop',
            );
            box.classList.add(`theme-${accent}`);
        }
        // 진행도 업데이트
        const fill = document.getElementById('process-progress-fill');
        if (fill) {
            let pct = 0;
            if (iconKey === 'label') pct = 10;
            else if (iconKey === 'openDoor') pct = 30;
            else if (iconKey === 'closeDoor') pct = 50;
            else if (iconKey === 'scan') pct = 75;
            else if (iconKey === 'collect') pct = 95;
            fill.style.width = pct + '%';
        }
    } catch (e) {
        // 안전 장치: 렌더 실패 시 텍스트만
        processMessage.textContent = message;
    }
}

// 원래 디자인 유지: 문 열림/닫힘 전용 렌더러 (inline SVG)
const SVG_OPEN = `
<svg width="90" height="90" viewBox="0 0 64 64" fill="none">
  <circle cx="32" cy="32" r="24" fill="#fff" stroke="#23262f" stroke-width="3"/>
  <circle cx="32" cy="10" r="24" ry="10" fill="#3772ff" stroke="#23262f" stroke-width="3"/>
 </svg>`;
const SVG_CLOSE = `
<svg width="90" height="90" viewBox="0 0 64 64" fill="none">
  <circle cx="32" cy="32" r="24" fill="#3772ff" stroke="#23262f" stroke-width="3"/>
 </svg>`;

function renderOpenDoorOriginal(messageHtml) {
    processMessage.innerHTML = `
        <div class="process-hero accent-open">
            <div class="icon-bubble">${SVG_OPEN}</div>
            <div class="process-title">${messageHtml}</div>
        </div>
    `;
    const box = document.querySelector('.process-box');
    if (box) {
        box.classList.remove('theme-close', 'theme-scan', 'theme-collect', 'theme-label', 'theme-warn', 'theme-stop');
        box.classList.add('theme-open');
    }
    const fill = document.getElementById('process-progress-fill');
    if (fill) fill.style.width = '30%';
}

function renderCloseDoorOriginal(messageText) {
    processMessage.innerHTML = `
        <div class="process-hero accent-close">
            <div class="icon-bubble">${SVG_CLOSE}</div>
            <div class="process-title">${messageText}</div>
        </div>
    `;
    const box = document.querySelector('.process-box');
    if (box) {
        box.classList.remove('theme-open', 'theme-scan', 'theme-collect', 'theme-label', 'theme-warn', 'theme-stop');
        box.classList.add('theme-close');
    }
    const fill = document.getElementById('process-progress-fill');
    if (fill) fill.style.width = '50%';
}

// 3분 후 텍스트 변경 및 버튼 추가 로직
let inactivityTimeout;
function handleInactivity() {
    clearTimeout(inactivityTimeout); // 기존 타임아웃 취소
    inactivityTimeout = setTimeout(() => {
        renderProcess('openDoor', '사용자가 없으면 아래 버튼을 눌러주세요.', 0);

        const returnButton = document.createElement('button');
        returnButton.textContent = '처음으로 돌아가기';
        returnButton.style =
            'font-size:1.2rem;padding:10px 28px;background:#3772ff;color:#fff;border:none;border-radius:8px;cursor:pointer;margin-top:12px;';
        returnButton.onclick = () => {
            console.log('Return Button clicked'); // 디버깅 로그 추가
            clearTimeout(inactivityTimeout);
            clearInterval(countdownInterval);
            console.log('Navigating to main screen'); // 디버깅 로그 추가

            showScreen('main-screen');
        };
        writeCmd('2'); // 시리얼로 '2' 전송
        processMessage.appendChild(returnButton);
    }, 180000); // 3분 (180,000ms) 테스트는 10초
}

// 종료하기 버튼 로직 수정 (포인트 적립 제거)
function handleExitButton() {
    const exitButton = document.createElement('button');
    exitButton.textContent = '종료하기';
    exitButton.style =
        'font-size:1.2rem;padding:10px 28px;background:#ff4d4d;color:#fff;border:none;border-radius:8px;cursor:pointer;margin-top:12px;';
    exitButton.onclick = async () => {
        try {
            clearTimeout(inactivityTimeout); // 비활성 타임아웃 취소
            clearTimeout(autoReturnTimeout); // 자동 닫힘 타임아웃 취소

            const commands = [
                { cmd: '2', msg: '문이 닫힙니다. 손 조심하세요! ⚠️' },
                { cmd: '3', msg: '자원을 판별하는 중입니다...' },
                { cmd: '4', msg: '자원을 수집하는 중입니다...' },
            ];

            for (let i = 0; i < commands.length; i++) {
                if (i === 0) {
                    renderCloseDoorOriginal(commands[i].msg);
                } else if (i === 1) {
                    renderProcess('scan', commands[i].msg, 2);
                } else {
                    renderProcess('collect', commands[i].msg, 3, { spin: true });
                }

                await writeCmd(commands[i].cmd);

                let completionMessage =
                    commands[i].cmd === '2'
                        ? 'Door closed successfully!'
                        : commands[i].cmd === '3'
                          ? 'Motor task completed!'
                          : '24V Motor stopped.';

                await waitForArduinoResponse(completionMessage);
            }

            await writeCmd('X'); // 시리얼로 'X' 전송
            showScreen('main-screen'); // 메인 화면으로 전환
        } catch (err) {
            if (handleDeviceLost(err)) return;
            console.error('종료 중 오류:', err);
            showErrorScreen('기기 오류가 발생했습니다. 관리자에게 문의해주세요.');
        }
    };

    processMessage.appendChild(exitButton);
}

async function startProcess() {
    clearTimeout(autoReturnTimeout); // 기존 타임아웃 취소
    clearTimeout(inactivityTimeout); // 기존 비활성 타임아웃 취소

    if (!isConnected) {
        alert('서버에 연결되지 않았습니다. 다시 시도해주세요.');
        return;
    }

    showScreen('process-screen');
    isStopped = false;
    stopButton.disabled = true;

    // 기존에 버튼이 있으면 제거
    if (closeDoorButton.parentNode) closeDoorButton.parentNode.removeChild(closeDoorButton);
    closeDoorButton.disabled = false;

    // 문 열기 바로 시작
    let openOrStopped;
    try {
        await writeCmd('1');
        openOrStopped = await waitForAnyArduinoResponse(
            [
                'Door will opened',
                'Door will open',
                'Door opened',
                'Door open',
                // 혹시 열림 직후 곧바로 모터 정지만 오는 경우도 처리
                'Motor stopped.',
                'Motor stopped',
            ],
            { timeoutMs: 60000 },
        );
    } catch (err) {
        if (handleDeviceLost(err)) return;
        showErrorScreen('기기 오류가 발생했습니다. 관리자에게 문의해주세요.');
        return;
    }

    // 문 열림 화면을 기존과 동일하게 표시
    const openMsg = `문이 열립니다.<br>페트병을 투입해주세요.<br>마지막으로 닫기 버튼을 눌러주세요.`;
    renderOpenDoorOriginal(openMsg);

    // "작동중지" 버튼 옆에 "닫힘" 버튼 추가
    stopButton.parentNode.insertBefore(closeDoorButton, stopButton.nextSibling);

    // 아직 모터 정지 신호를 못 받았다면 여기서 대기(문구 변형 대비)
    if (!/motor stopped/i.test(openOrStopped)) {
        await waitForAnyArduinoResponse(['Motor stopped.', 'Motor stopped']);
    }

    // 비활성 상태 감지 시작
    handleInactivity();

    // 닫힘 -> 판별 -> 수집
    closeDoorButton.onclick = async () => {
        clearTimeout(inactivityTimeout); // 비활성 타임아웃 취소
        if (closeDoorButton.parentNode) closeDoorButton.parentNode.removeChild(closeDoorButton);
        closeDoorButton.disabled = true;
        try {
            const commands = [
                { cmd: '2', msg: '문이 닫힙니다. 손 조심하세요! ⚠️' },
                { cmd: '3', msg: '자원을 판별하는 중입니다...' },
                { cmd: '4', msg: '자원을 수집하는 중입니다...' },
            ];

            for (let i = 0; i < commands.length; i++) {
                if (i === 0) {
                    renderCloseDoorOriginal(commands[i].msg);
                } else if (i === 1) {
                    renderProcess('scan', commands[i].msg, 2);
                } else {
                    renderProcess('collect', commands[i].msg, 3, { spin: true });
                }

                await writeCmd(commands[i].cmd);

                let completionMessage =
                    commands[i].cmd === '2'
                        ? 'Door closed successfully!'
                        : commands[i].cmd === '3'
                          ? 'Motor task completed!'
                          : '24V Motor stopped.';

                await waitForArduinoResponse(completionMessage);
            }
            stopButton.disabled = true;
            if (isStopped) {
                showScreen('main-screen');
                return;
            }
            // 1회 투입 완료 → 누적 카운트 증가
            depositCount += 1;

            // 포인트 적립은 '처음 화면으로' 돌아갈 때 한 번 호출
            showScreen('end-screen');
        } catch (err) {
            if (handleDeviceLost(err)) return;
            console.error('닫힘/판별/수집 중 오류:', err);
            showErrorScreen('기기 오류가 발생했습니다. 관리자에게 문의해주세요.');
        }
    };
}

async function sendCommand(command, expectedResponse) {
    try {
        console.log(`Preparing to send command: '${command}'`); // 명령 준비 로그 추가
        await writeCmd(command); // 줄 종료 자동 부착
        console.log(`Command successfully sent: '${command}'`); // 명령 전송 성공 로그 추가
        if (expectedResponse) {
            await waitForArduinoResponse(expectedResponse);
        }
    } catch (error) {
        console.error(`Error sending command '${command}':`, error);
        if (handleDeviceLost(error)) return;
        showErrorScreen('기기 오류가 발생했습니다. 관리자에게 문의해주세요.');
    }
}

// 공통: 수신 데이터에 'already' 포함 시 센서 오류 처리
function detectAndHandleAlready(data) {
    try {
        if (typeof data === 'string' && data.toLowerCase().includes('already')) {
            showErrorScreen('센서 상태 오류, 관리자에게 문의해주세요.');
            return true;
        }
    } catch {}
    return false;
}

function waitForArduinoResponse(targetMessage) {
    return new Promise((resolve, reject) => {
        let receivedData = '';
        const loop = async () => {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    reject('Reader stream closed unexpectedly.');
                    return;
                }
                if (value) {
                    receivedData += value;
                    console.log('Received data (raw):', value); // 수신된 원본 데이터 로그 추가
                    console.log('Accumulated data:', receivedData); // 누적된 데이터 로그 추가

                    // 에러 신호 감지
                    if (receivedData.includes('ERROR:')) {
                        const line = receivedData.split(/\r?\n/).find((l) => l.includes('ERROR:')) || '기기 오류';
                        showErrorScreen(line.replace(/.*ERROR:\s*/, '기기 오류: '));
                        return; // 에러 발생 시 흐름 중단
                    }

                    // 'already' 감지 시 센서 오류 처리
                    if (detectAndHandleAlready(receivedData)) {
                        return;
                    }

                    if (receivedData.includes(targetMessage)) {
                        console.log('Target message received:', targetMessage); // 디버깅 로그 추가
                        resolve();
                        return;
                    }
                }
                loop();
            } catch (error) {
                console.error('Error in waitForArduinoResponse loop:', error);
                if (!handleDeviceLost(error)) {
                    // 장치 분리 외 예외
                }
                reject(error);
            }
        };
        loop();
    });
}

// 열림/상태 신호를 다중 패턴으로 대기
function normalizeText(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
}
function waitForAnyArduinoResponse(targetMessages, { timeoutMs = 30000 } = {}) {
    const normalizedTargets = targetMessages.map((m) => normalizeText(m));
    return new Promise((resolve, reject) => {
        let receivedData = '';
        const timer = setTimeout(() => {
            console.warn('waitForAnyArduinoResponse timeout', { targetMessages });
            reject(new Error('Timeout while waiting for Arduino response'));
        }, timeoutMs);

        const loop = async () => {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    clearTimeout(timer);
                    reject('Reader stream closed unexpectedly.');
                    return;
                }
                if (value) {
                    receivedData += value;
                    console.log('[ANY] raw:', value);
                    console.log('[ANY] acc:', receivedData);

                    // 에러 신호 감지
                    if (receivedData.includes('ERROR:')) {
                        clearTimeout(timer);
                        const line = receivedData.split(/\r?\n/).find((l) => l.includes('ERROR:')) || '기기 오류';
                        showErrorScreen(line.replace(/.*ERROR:\s*/, '기기 오류: '));
                        return;
                    }

                    // 'already' 감지 시 센서 오류 처리
                    if (detectAndHandleAlready(receivedData)) {
                        clearTimeout(timer);
                        return;
                    }

                    const normalized = normalizeText(receivedData);
                    const hitIdx = normalizedTargets.findIndex((t) => normalized.includes(t));
                    if (hitIdx !== -1) {
                        clearTimeout(timer);
                        const hit = targetMessages[hitIdx];
                        console.log('Matched message:', hit);
                        resolve(hit);
                        return;
                    }
                }
                loop();
            } catch (error) {
                clearTimeout(timer);
                console.error('Error in waitForAnyArduinoResponse loop:', error);
                if (!handleDeviceLost(error)) {
                    // 장치 분리 외 예외
                }
                reject(error);
            }
        };
        loop();
    });
}

// 2단계(문 닫기) 중 손 감지 처리 대기
function waitForCloseOrHand(targetMessage) {
    return new Promise((resolve, reject) => {
        let receivedData = '';
        const loop = async () => {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    reject('Reader stream closed unexpectedly.');
                    return;
                }
                if (value) {
                    receivedData += value;
                    console.log('[CloseOrHand] raw:', value);
                    console.log('[CloseOrHand] acc:', receivedData);

                    // 에러 신호 감지
                    if (receivedData.includes('ERROR:')) {
                        const line = receivedData.split(/\r?\n/).find((l) => l.includes('ERROR:')) || '기기 오류';
                        showErrorScreen(line.replace(/.*ERROR:\s*/, '기기 오류: '));
                        return;
                    }

                    // 'already' 감지 시 센서 오류 처리
                    if (detectAndHandleAlready(receivedData)) {
                        return;
                    }

                    if (receivedData.includes('HAND DETECTED!') || receivedData.includes('23')) {
                        renderProcess('hand', '손이 감지되었습니다. 문이 열립니다.', 1);
                        resolve({ status: 'hand' });
                        return;
                    }

                    if (receivedData.includes(targetMessage)) {
                        resolve({ status: 'ok' });
                        return;
                    }
                }
                loop();
            } catch (error) {
                console.error('Error in waitForCloseOrHand loop:', error);
                if (!handleDeviceLost(error)) {
                    // 장치 분리 외 예외
                }
                reject(error);
            }
        };
        loop();
    });
}

// 2→3→4 단계 실행: 닫힘 중 손 감지 시 다시 열었다가 재시도 후 이어서 진행
async function runCloseClassifyCollectSequence() {
    // 2. 닫힘
    renderCloseDoorOriginal('문이 닫힙니다. 손 조심하세요! ⚠️');
    await writeCmd('2');
    const closeResult = await waitForCloseOrHand('Door closed successfully!');

    if (closeResult.status === 'hand') {
        // 다시 열기
        await writeCmd('1');
        await waitForArduinoResponse('Motor stopped.');

        // 재닫기 안내
        renderCloseDoorOriginal('문이 다시 닫힙니다. 손을 치워주세요. ⚠️');
        await writeCmd('2');
        await waitForArduinoResponse('Door closed successfully!');
    }

    // 3. 판별중
    renderProcess('scan', '자원을 판별하는 중입니다...', 2);
    await writeCmd('3');
    await waitForArduinoResponse('Motor task completed!');

    // 4. 수집중
    renderProcess('collect', '자원을 수집하는 중입니다...', 3, { spin: true });
    await writeCmd('4');
    await waitForArduinoResponse('24V Motor stopped.');
}

// ========== Fa-duino 연결 ==========
async function connectToFaduino() {
    try {
        if (__testMode) {
            installSimulator();
            return;
        }
        if (!port) {
            const ports = await navigator.serial.getPorts();
            port = ports.length ? ports[0] : await navigator.serial.requestPort();
        }

        if (port.readable || port.writable) {
            isConnected = true;
            return;
        }

        await port.open({ baudRate: 9600 });

        const decoder = new TextDecoderStream();
        port.readable.pipeTo(decoder.writable);
        reader = decoder.readable.getReader();

        const encoder = new TextEncoderStream();
        encoder.readable.pipeTo(port.writable);
        writer = encoder.writable.getWriter();

        isConnected = true;
        // 연결되면 유지보수 모드 해제 및 상태 패널 갱신
        if (window) {
            window.__maintenanceMode = false;
            if (window.startPeriodicStatusCheck) {
                window.startPeriodicStatusCheck();
            }
        }
        const arduinoStatus = document.getElementById('arduino-status');
        const machineStatus = document.getElementById('machine-status');
        if (arduinoStatus) {
            arduinoStatus.textContent = '정상';
            arduinoStatus.style.color = '#00ff4c';
        }
        if (machineStatus) {
            machineStatus.textContent = '가능';
            machineStatus.style.color = '#00ff4c';
        }
        // 로그인 버튼 재활성화 및 라벨 복구
        if (loginButton) {
            loginButton.disabled = false;
            loginButton.textContent = '시작하기';
        }
    } catch (err) {
        console.error('Serial error:', err);
        isConnected = false;
        alert('연결에 실패했습니다. 다시 시도해주세요.');
    }
}

// ========== 이벤트 ==========
loginButton.addEventListener('click', () => {
    loginPopup.style.display = 'flex';
    connectToFaduino();
});

loginSubmit.addEventListener('click', async () => {
    const phone = phoneNumberInput.value;
    if (phone.length === 13) {
        loginPopup.style.display = 'none';
        currentPhoneNumber = phone;
        depositCount = 0; // 로그인 시 카운트 초기화

        // 99 명령 먼저 전송 후 1초 뒤에 startProcess()
        if (writer) {
            try {
                await writeCmd('99');
                setTimeout(() => {
                    startProcess();
                }, 1000);
            } catch (e) {
                alert('장치에 명령을 전송할 수 없습니다.');
            }
        } else {
            startProcess();
        }
    } else alert('올바른 전화번호를 입력하세요. (예: 010-1234-5678)');
});

keypad.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    const key = e.target.textContent;
    let val = phoneNumberInput.value.replace(/-/g, '');
    if (key === '←') val = val.slice(0, -1);
    else if (key === 'C') val = '';
    else if (!isNaN(key) && val.length < 11) val += key;

    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 3);
    if (val.length >= 4) formatted += '-' + val.substring(3, 7);
    if (val.length >= 8) formatted += '-' + val.substring(7, 11);
    phoneNumberInput.value = formatted;
});

phoneNumberInput.addEventListener('input', (e) => {
    let v = e.target.value.replace(/-/g, '');
    let f = '';
    if (v.length > 0) f += v.substring(0, 3);
    if (v.length >= 4) f += '-' + v.substring(3, 7);
    if (v.length >= 8) f += '-' + v.substring(7, 11);
    e.target.value = f;
});

stopButton.addEventListener('click', async () => {
    isStopped = true;
    stopButton.disabled = true;

    // 1번만 끝난 상태에서 중지 시 닫힘 버튼 클릭 로직 자동 실행
    if (!closeDoorButton.disabled && closeDoorButton.parentNode) {
        try {
            closeDoorButton.disabled = true;
            if (closeDoorButton.parentNode) closeDoorButton.parentNode.removeChild(closeDoorButton);

            const commands = [
                { cmd: '2', msg: '문이 닫힙니다. 손 조심하세요! ⚠️' },
                { cmd: '3', msg: '자원을 판별하는 중입니다...' },
                { cmd: '4', msg: '자원을 수집하는 중입니다...' },
            ];
            for (let i = 0; i < commands.length; i++) {
                renderProcess('stop', '작동을 중지중입니다...', 0, { spin: true });

                await writeCmd(commands[i].cmd);

                let completionMessage =
                    commands[i].cmd === '2'
                        ? 'Motor stopped.'
                        : commands[i].cmd === '3'
                          ? 'Motor task completed!'
                          : '24V Motor stopped.';

                await waitForArduinoResponse(completionMessage);
            }
            showScreen('main-screen');
        } catch (err) {
            if (handleDeviceLost(err)) return;
            console.error('중지 처리 중 오류:', err);
            showErrorScreen('기기 오류가 발생했습니다. 관리자에게 문의해주세요.');
        }
    }
});

returnHomeButton.addEventListener('click', () => {
    console.log('Return Home button clicked'); // 디버깅 로그 추가
    clearTimeout(autoReturnTimeout);
    clearInterval(countdownInterval);
    console.log('Navigating to main screen'); // 디버깅 로그 추가
    showScreen('main-screen');
});
addMoreButton.addEventListener('click', async () => {
    console.log('Add More button clicked'); // 디버깅 로그 추가
    clearTimeout(autoReturnTimeout); // 기존 타임아웃 취소
    autoReturnTimeout = null; // 변수 초기화
    clearInterval(countdownInterval); // 카운트다운 초기화

    // 추가 투입 시 상태 초기화 후 처음부터 다시 시작
    isStopped = false;
    stopButton.disabled = false;
    await startProcess();
});

// 회전 애니메이션 CSS 추가 (최초 1회만)
if (!document.getElementById('spin-style')) {
    const style = document.createElement('style');
    style.id = 'spin-style';
    style.innerHTML = `
    .spin {
        animation: spin 1s linear infinite;
    }
    @keyframes spin {
        100% { transform: rotate(360deg);}
    }
    `;
    document.head.appendChild(style);
}

// motorStop 함수 수정
async function motorStop() {
    if (writer) {
        try {
            await writeCmd('X'); // 모터 정지 신호 전송
            console.log('모터 정지 신호 전송 완료'); // 디버깅 로그 추가
            await waitForArduinoResponse('Motor stopped.'); // 모터 정지 확인
            console.log('모터 정지 확인 완료'); // 디버깅 로그 추가
        } catch (e) {
            console.error('모터 정지 신호 전송 실패:', e);
        }
    } else {
        console.error('Writer가 초기화되지 않았습니다. 모터 정지 신호를 보낼 수 없습니다.');
    }
}

// 로그인 팝업 닫기 버튼
const keypadCloseButton = document.createElement('button');
keypadCloseButton.textContent = 'X';
keypadCloseButton.style =
    'position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #fff;';
keypadCloseButton.onclick = () => {
    loginPopup.style.display = 'none';
};
keypad.parentNode.style.position = 'relative'; // Ensure the parent has relative positioning for absolute child
keypad.parentNode.appendChild(keypadCloseButton);

// 전역: 처리되지 않은 Promise 거부 캐치 → 장치 분리시 사용자 안내
if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (event) => {
        if (handleDeviceLost(event.reason)) {
            event.preventDefault?.();
        }
    });
    // 초기 지점명 로드
    loadDeviceConfig();
    // 포인트 로그 내보내기: Ctrl+Alt+L
    window.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) {
            try {
                if (!navigator?.storage?.getDirectory) return alert('로그 파일 시스템 접근을 지원하지 않습니다.');
                const root = await navigator.storage.getDirectory();
                const dir = await root.getDirectoryHandle('petmon');
                const file = await dir.getFileHandle('point_log.txt');
                const blob = await file.getFile();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'point_log.txt';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                }, 0);
            } catch (err) {
                alert('로그 파일이 아직 없습니다. (투입 후 생성됩니다)');
            }
        }
    });
    // 테스트 모드 토글/오류 트리거 + 관리자 모드 진입
    const toggleBtn = document.getElementById('btn-toggle-test');
    const errBtn = document.getElementById('btn-test-error');
    const skipBtn = document.getElementById('btn-skip-cutter');
    const testControls = document.getElementById('test-controls');
    const adminTrigger = document.getElementById('admin-mode-trigger');

    // 관리자 모드 전에는 숨김
    if (testControls) testControls.style.display = 'none';

    function exitAdminMode() {
        __testMode = false;
        updateTestBadge();
        if (testControls) testControls.style.display = 'none';
    }

    function ensureExitButton() {
        if (!testControls) return;
        let exitBtn = document.getElementById('btn-exit-admin');
        if (!exitBtn) {
            exitBtn = document.createElement('button');
            exitBtn.id = 'btn-exit-admin';
            exitBtn.textContent = '관리자모드 종료';
            exitBtn.style.cssText =
                'font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid #475569;background:#111827;color:#e5e7eb;cursor:pointer;';
            exitBtn.addEventListener('click', exitAdminMode);
            testControls.appendChild(exitBtn);
        }
    }

    function enterAdminMode() {
        if (testControls) testControls.style.display = 'flex';
        ensureExitButton();
    }

    // 1초 내 4회 연속 클릭 시 관리자 모드 진입
    if (adminTrigger) {
        let clicks = 0;
        let timer = null;
        adminTrigger.addEventListener('click', () => {
            if (clicks === 0) {
                timer = setTimeout(() => {
                    clicks = 0;
                    timer = null;
                }, 1000);
            }
            clicks++;
            if (clicks >= 4) {
                clicks = 0;
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                enterAdminMode();
            }
        });
    }
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            __testMode = !__testMode;
            updateTestBadge();
            if (__testMode) {
                if (!isConnected) installSimulator();
            } else {
                teardownSerial();
            }
        });
    }
    if (errBtn) {
        errBtn.addEventListener('click', () => {
            if (!__testMode) return alert('테스트 모드를 먼저 켜세요.');
            showErrorScreen('테스트: 임의 오류 화면입니다.');
        });
    }
    if (skipBtn) {
        skipBtn.addEventListener('click', () => {
            if (!__testMode) return alert('테스트 모드를 먼저 켜세요.');
            // 문 열림 시퀀스를 바로 트리거
            simEnqueue('Door will open', 200);
            simEnqueue('Motor stopped.', 400);
        });
    }
    updateTestBadge();
}
