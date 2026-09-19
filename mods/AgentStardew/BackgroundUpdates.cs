using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;

namespace AgentStardew;

// 只在游戏更新期间覆盖失焦暂停，保留玩家保存的选项。
internal sealed class BackgroundUpdates : IDisposable
{
    private Options? options;
    private bool pauseWhenOutOfFocus;
    private GraphicsDeviceManager? graphics;

    public void Initialize()
    {
        if (!OperatingSystem.IsMacOS() || graphics != null) return;
        // macOS 遮挡窗口时等待垂直同步可能阻塞整个主线程，包括网络队列的消费。
        graphics = Game1.graphics;
        graphics.PreparingDeviceSettings += OnPreparingDeviceSettings;
        graphics.ApplyChanges();
    }

    private void OnPreparingDeviceSettings(object? sender, PreparingDeviceSettingsEventArgs e)
        => e.GraphicsDeviceInformation.PresentationParameters.PresentationInterval = PresentInterval.Immediate;

    public void BeforeUpdate()
    {
        AfterUpdate();
        if (GameRunner.instance.IsActive) return;
        options = Game1.options;
        if (options == null) return;
        pauseWhenOutOfFocus = options.pauseWhenOutOfFocus;
        options.pauseWhenOutOfFocus = false;
    }

    public void AfterUpdate()
    {
        if (options == null) return;
        options.pauseWhenOutOfFocus = pauseWhenOutOfFocus;
        options = null;
    }

    public void Dispose()
    {
        AfterUpdate();
        if (graphics != null) graphics.PreparingDeviceSettings -= OnPreparingDeviceSettings;
    }
}
