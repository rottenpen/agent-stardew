using StardewValley.Util;

namespace AgentStardew;

// 游戏原生模拟输入在失焦时仍会消费；每帧只注入当前动作选择的方向。
internal sealed class MovementInput : IInputSimulator
{
    public int Direction { get; set; } = -1;
    private int previous = -1;

    public void SimulateInput(ref bool actionButtonPressed, ref bool switchToolButtonPressed,
        ref bool useToolButtonPressed, ref bool useToolButtonReleased,
        ref bool addItemToInventoryButtonPressed, ref bool cancelButtonPressed,
        ref bool moveUpPressed, ref bool moveRightPressed, ref bool moveLeftPressed, ref bool moveDownPressed,
        ref bool moveUpReleased, ref bool moveRightReleased, ref bool moveLeftReleased, ref bool moveDownReleased,
        ref bool moveUpHeld, ref bool moveRightHeld, ref bool moveLeftHeld, ref bool moveDownHeld)
    {
        actionButtonPressed = switchToolButtonPressed = useToolButtonPressed = useToolButtonReleased = false;
        addItemToInventoryButtonPressed = cancelButtonPressed = false;
        moveUpPressed = Direction == 0 && previous != 0;
        moveRightPressed = Direction == 1 && previous != 1;
        moveDownPressed = Direction == 2 && previous != 2;
        moveLeftPressed = Direction == 3 && previous != 3;
        moveUpHeld = Direction == 0;
        moveRightHeld = Direction == 1;
        moveDownHeld = Direction == 2;
        moveLeftHeld = Direction == 3;
        // 覆盖失焦前可能残留的真实按键状态。
        moveUpReleased = Direction != 0;
        moveRightReleased = Direction != 1;
        moveDownReleased = Direction != 2;
        moveLeftReleased = Direction != 3;
        previous = Direction;
        Direction = -1;
    }
}
