namespace AgentStardew;

public static class InteractionEvidence
{
    public static bool Changed(bool locationChanged, bool menuChanged, bool inventoryChanged, bool targetDisappeared) =>
        locationChanged || menuChanged || inventoryChanged || targetDisappeared;
}
