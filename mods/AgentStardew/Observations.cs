using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using StardewValley.Buildings;

namespace AgentStardew;

public sealed class Observations
{
    public sealed record Target(GameLocation Location, int Generation, Point Tile, object? Identity, string Kind, string? Action = null, int Option = -1);
    private readonly Dictionary<string, Target> references = new();
    private readonly Queue<List<string>> snapshots = new();
    private long sequence;
    public string InstanceId { get; } = Guid.NewGuid().ToString("N");
    public int Generation { get; private set; }
    public void Reset() { Generation++; references.Clear(); snapshots.Clear(); }
    public static object Tile(Point p) => new { x = p.X, y = p.Y };
    public static Point Position => Game1.player.TilePoint;
    public static bool InBounds(GameLocation location, Point p) => p.X >= 0 && p.Y >= 0 && p.X < location.Map.Layers[0].LayerWidth && p.Y < location.Map.Layers[0].LayerHeight;
    public static bool Walkable(GameLocation location, Point p)
    {
        if (!InBounds(location, p)) return false;
        var box = Game1.player.GetBoundingBox();
        box.Offset(p.X * 64 + 32 - box.Center.X, p.Y * 64 + 32 - box.Center.Y);
        return !location.isCollidingPosition(box, Game1.viewport, false, 0, false, Game1.player);
    }
    public Target Resolve(string reference, bool menu = false)
    {
        if (!references.TryGetValue(reference, out var target) || target.Generation != Generation || !ReferenceEquals(target.Location, Game1.currentLocation))
            throw new ActionFault("STALE_REF", "引用不属于当前场景或已过期，请重新 snapshot。");
        if (menu)
        {
            if (target.Kind != "menu" || !ReferenceEquals(target.Identity, Game1.activeClickableMenu) || target.Action != MenuSignature(Game1.activeClickableMenu)) throw new ActionFault("MENU_MISMATCH", "菜单已改变，请重新 snapshot。");
        }
        else if (target.Kind == "menu") throw new ActionFault("INVALID_ARGUMENT", "动作需要场景目标引用。");
        else if (target.Identity is NPC npc)
        {
            if (!target.Location.characters.Contains(npc)) throw new ActionFault("STALE_REF", "角色已离开当前地图。");
            target = target with { Tile = npc.TilePoint };
        }
        else if (target.Identity is Furniture furniture)
        {
            if (!target.Location.furniture.Contains(furniture) || furniture.TileLocation.ToPoint() != target.Tile) throw new ActionFault("STALE_REF", "家具已移动或消失。");
        }
        else if (target.Identity is StardewValley.Object obj)
        {
            if (!target.Location.objects.TryGetValue(target.Tile.ToVector2(), out var current) || !ReferenceEquals(current, obj)) throw new ActionFault("STALE_REF", "对象已改变或消失。");
        }
        else if (target.Identity is TerrainFeature feature)
        {
            if (!target.Location.terrainFeatures.TryGetValue(target.Tile.ToVector2(), out var current) || !ReferenceEquals(current, feature)) throw new ActionFault("STALE_REF", "地形目标已消失。");
        }
        else if (target.Identity is Warp warp && !target.Location.warps.Contains(warp)) throw new ActionFault("STALE_REF", "出口已改变。");
        else if (target.Identity is Building building && (!target.Location.buildings.Contains(building) || building.getPointForHumanDoor() != target.Tile)) throw new ActionFault("STALE_REF", "建筑入口已移动或消失。");
        else if (target.Kind == "action" && MapAction(target.Location, target.Tile) != target.Action) throw new ActionFault("STALE_REF", "地图交互点已改变。");
        return target;
    }
    public static string MenuSignature(IClickableMenu? menu) => menu is DialogueBox dialogue
        ? dialogue.getCurrentString() + "\n" + string.Join("|", (dialogue.responses ?? Array.Empty<StardewValley.Response>()).Select(r => r.responseKey + ":" + r.responseText))
        : menu?.GetType().FullName ?? "";
    private static string? MapAction(GameLocation location, Point p) => location.doesTileHaveProperty(p.X, p.Y, "Action", "Buildings") ?? location.doesTileHaveProperty(p.X, p.Y, "TouchAction", "Back");
    public object Snapshot(int radius = 8)
    {
        var location = Game1.currentLocation;
        var center = Position;
        var id = "s" + ++sequence;
        var keys = new List<string>();
        string Add(Target target, bool menu = false)
        {
            var reference = $"@{id}:{(menu ? "m" : "e")}{keys.Count + 1}";
            references.Add(reference, target); keys.Add(reference); return reference;
        }
        var entities = new List<object>();
        var width = location.Map.Layers[0].LayerWidth;
        var height = location.Map.Layers[0].LayerHeight;
        // 全量显示观察方框中的地块；明确范围，路径规划仍由游戏碰撞检查决定。
        for (var y = Math.Max(0, center.Y - radius); y <= Math.Min(height - 1, center.Y + radius); y++)
        for (var x = Math.Max(0, center.X - radius); x <= Math.Min(width - 1, center.X + radius); x++)
        {
            var p = new Point(x, y);
            location.terrainFeatures.TryGetValue(p.ToVector2(), out var terrain);
            location.objects.TryGetValue(p.ToVector2(), out var obj);
            var dirt = terrain as HoeDirt;
            var action = MapAction(location, p);
            var water = location.CanRefillWateringCanOnTile(x, y);
            var kind = obj != null ? "object" : action != null ? "action" : dirt != null ? "soil" : terrain != null ? "terrain" : water ? "water" : "tile";
            var name = obj?.DisplayName ?? (action != null ? action : dirt?.crop != null ? "作物" : dirt != null ? "耕地" : terrain?.GetType().Name ?? (water ? "水源" : location.doesTileHaveProperty(x, y, "Diggable", "Back") != null ? "可耕地" : "地块"));
            // 土地引用固定格子；树、杂草、石头等实体引用固定实际对象。
            object? identity = obj ?? (object?)(terrain is HoeDirt ? null : terrain);
            var reference = Add(new(location, Generation, p, identity, kind, action));
            var entity = new Dictionary<string, object?> { ["ref"] = reference, ["kind"] = kind, ["name"] = name, ["tile"] = Tile(p), ["passable"] = Walkable(location, p) };
            entity["diggable"] = obj == null && terrain == null && action == null && location.doesTileHaveProperty(x, y, "Diggable", "Back") != null;
            entity["refillable"] = water;
            entity["needsWater"] = dirt?.crop != null && !dirt.crop.dead.Value && dirt.needsWatering() && dirt.state.Value != HoeDirt.watered;
            if (dirt != null) { entity["tilled"] = true; entity["watered"] = dirt.state.Value == HoeDirt.watered; if (dirt.crop != null) entity["crop"] = dirt.crop.indexOfHarvest.Value; }
            if (action != null) entity["action"] = action;
            entities.Add(entity);
        }
        bool Nearby(Point p) => Math.Abs(p.X - center.X) <= radius && Math.Abs(p.Y - center.Y) <= radius;
        foreach (var building in location.buildings)
        {
            if (building.humanDoor.Value.X < 0 || building.humanDoor.Value.Y < 0) continue;
            var p = building.getPointForHumanDoor();
            if (!Nearby(p) || !InBounds(location, p)) continue;
            var isHome = location is Farm farm && ReferenceEquals(farm.GetMainFarmHouse(), building);
            var reference = Add(new(location, Generation, p, building, "door"));
            entities.Add(new { @ref = reference, kind = "door", name = isHome ? "农舍入口" : $"建筑入口 → {building.GetIndoorsName()}", tile = Tile(p), passable = false });
        }
        foreach (var furniture in location.furniture.Where(f => Nearby(f.TileLocation.ToPoint())))
        {
            var p = furniture.TileLocation.ToPoint();
            var reference = Add(new(location, Generation, p, furniture, furniture is BedFurniture ? "bed" : "furniture"));
            entities.Add(new { @ref = reference, kind = furniture is BedFurniture ? "bed" : "furniture", name = furniture.DisplayName, tile = Tile(p), passable = false });
        }
        foreach (var warp in location.warps.Where(w => Nearby(new Point(w.X, w.Y))))
        {
            var p = new Point(warp.X, warp.Y);
            var reference = Add(new(location, Generation, p, warp, "exit"));
            entities.Add(new { @ref = reference, kind = "exit", name = $"出口 → {warp.TargetName}", tile = Tile(p), passable = true, action = "移动到该格子触发出口" });
        }
        foreach (var npc in location.characters.Where(n => Nearby(n.TilePoint)))
        {
            var reference = Add(new(location, Generation, npc.TilePoint, npc, "npc"));
            entities.Add(new { @ref = reference, kind = "npc", name = npc.displayName, tile = Tile(npc.TilePoint), passable = false });
        }
        object? menu = null;
        if (Game1.activeClickableMenu is { } currentMenu)
        {
            var options = new List<object>();
            if (currentMenu is DialogueBox dialogue)
            {
                if (dialogue.responses is { Length: > 0 })
                    for (var i = 0; i < dialogue.responses.Length; i++) options.Add(new { @ref = Add(new(location, Generation, center, currentMenu, "menu", Action: MenuSignature(currentMenu), Option: i), true), label = dialogue.responses[i].responseText });
                else options.Add(new { @ref = Add(new(location, Generation, center, currentMenu, "menu", Action: MenuSignature(currentMenu), Option: -1), true), label = "继续" });
                menu = new { type = currentMenu.GetType().Name, text = dialogue.getCurrentString(), options };
            }
            else menu = new { type = currentMenu.GetType().Name, text = "当前菜单暂不支持自动操作。", options };
        }
        snapshots.Enqueue(keys);
        while (snapshots.Count > 16) foreach (var key in snapshots.Dequeue()) references.Remove(key);
        var inventory = Game1.player.Items.Select((item, slot) => (item, slot)).Where(v => v.item != null).Select(v =>
        {
            var entry = new Dictionary<string, object> { ["slot"] = v.slot, ["itemId"] = v.item.QualifiedItemId, ["name"] = v.item.DisplayName, ["count"] = v.item.Stack };
            entry["category"] = v.item.Category;
            if (v.item is Tool tool) entry["tool"] = tool.GetType().Name;
            if (v.item is WateringCan can) { entry["water"] = can.WaterLeft; entry["waterCapacity"] = can.waterCanMax; }
            return entry;
        }).ToArray();
        return new { mode = "game", kind = "snapshot", snapshotId = id, instanceId = InstanceId, saveGeneration = Generation, location = location.NameOrUniqueName,
            date = new { season = Game1.currentSeason, day = Game1.dayOfMonth, year = Game1.year }, time = Game1.timeOfDay,
            player = new { position = Tile(center), energy = Game1.player.Stamina, maxEnergy = Game1.player.MaxStamina, selectedSlot = Game1.player.CurrentToolIndex, canMove = Game1.player.CanMove },
            inventory, observation = new { radius, center = Tile(center), truncated = center.X - radius > 0 || center.Y - radius > 0 || center.X + radius < width - 1 || center.Y + radius < height - 1, width, height }, entities, menu };
    }
    public object Result(string detail, bool changed = true) => new { kind = "action", location = Game1.currentLocation.NameOrUniqueName, position = Tile(Position), changed, detail, snapshot = Snapshot() };
}
