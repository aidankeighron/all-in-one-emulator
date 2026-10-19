const games = [
    { id: "smg", title: "Super Mario Galaxy", console: "wii", file: "/roms/wii/smg.iso" },
    { id: "mkdd", title: "Mario Kart: Double Dash", console: "gamecube", file: "/roms/gamecube/mkdd.iso" },
    { id: "mk8", title: "Mario Kart 8", console: "switch", file: "/roms/switch/mk8.nsp" }
];

let selectedIndex = 0;
let lastButtonState = { dpadRight: false, dpadLeft: false, buttonA: false };

function renderGrid() {
    const grid = document.getElementById("game-grid");
    grid.innerHTML = "";
    games.forEach((game, index) => {
        const div = document.createElement("div");
        div.className = `channel ${index === selectedIndex ? "selected" : ""}`;
        div.innerText = game.title;
        grid.appendChild(div);
    });
}

// 60FPS Controller Polling Loop
function pollController() {
    const gamepads = navigator.getGamepads();
    if (gamepads[0]) {
        const gp = gamepads[0];
        // Standard mapping: D-Pad Right = button 15, Left = 14, A = 0
        const dpadRight = gp.buttons[15]?.pressed || gp.axes[0] > 0.5;
        const dpadLeft = gp.buttons[14]?.pressed || gp.axes[0] < -0.5;
        const buttonA = gp.buttons[0]?.pressed;

        if (dpadRight && !lastButtonState.dpadRight && selectedIndex < games.length - 1) {
            selectedIndex++;
            renderGrid();
        }
        if (dpadLeft && !lastButtonState.dpadLeft && selectedIndex > 0) {
            selectedIndex--;
            renderGrid();
        }
        if (buttonA && !lastButtonState.buttonA) {
            launchGame(games[selectedIndex]);
        }

        lastButtonState = { dpadRight, dpadLeft, buttonA };
    }
    requestAnimationFrame(pollController);
}

function launchGame(game) {
    console.log(`[ROUTER] Executing: ./run-${game.console}.sh "${game.file}"`);
    
    // When wrapped in Tauri or Node later, this will execute the actual shell script:
    // const { exec } = require('child_process');
    // exec(`~/retro-box/run-dolphin.sh "${game.file}"`);
}

window.addEventListener("gamepadconnected", (e) => {
    console.log("Xbox Controller Connected:", e.gamepad.id);
});

renderGrid();
requestAnimationFrame(pollController);