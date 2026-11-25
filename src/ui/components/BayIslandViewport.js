import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * Custom Clutter/St container actor providing smooth clipped morphing transitions
 * and centering its child actor during width/height interpolation.
 */
export const BayIslandViewport = GObject.registerClass(
class BayIslandViewport extends St.Widget {
    _init(params = {}) {
        super._init({
            clip_to_allocation: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
            ...params,
        });
        this._lockedSize = null;
    }

    setChild(actor, lockedSize = null) {
        this._lockedSize = lockedSize
            ? {
                width: Math.max(1, Math.round(lockedSize.width)),
                height: Math.max(1, Math.round(lockedSize.height)),
            }
            : null;
        this.clip_to_allocation = Boolean(this._lockedSize);

        const cur = this.get_first_child();
        if (cur === actor) {
            this.queue_relayout();
            return;
        }
        if (cur) {
            this.remove_child(cur);
            if (!cur._keepAlive && !cur.isPersistent) {
                try {
                    cur.destroy();
                } catch {
                    // Already destroyed
                }
            }
        }
        if (actor)
            this.add_child(actor);
        this.queue_relayout();
    }

    setLockedSize(lockedSize) {
        const next = lockedSize
            ? {
                width: Math.max(1, Math.round(lockedSize.width)),
                height: Math.max(1, Math.round(lockedSize.height)),
            }
            : null;
        if (next && this._lockedSize &&
            next.width === this._lockedSize.width &&
            next.height === this._lockedSize.height)
            return;
        if (!next && !this._lockedSize)
            return;
        this._lockedSize = next;
        this.clip_to_allocation = Boolean(this._lockedSize);
        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        const child = this.get_first_child();
        if (!child || !child.visible)
            return [0, 0];
        const [minW, natW] = child.get_preferred_width(forHeight);
        if (this._lockedSize)
            return [0, Math.max(minW, this._lockedSize.width)];
        return [minW, natW];
    }

    vfunc_get_preferred_height(forWidth) {
        const child = this.get_first_child();
        if (!child || !child.visible)
            return [0, 0];
        const queryW = this._lockedSize ? this._lockedSize.width : forWidth;
        const [minH, natH] = child.get_preferred_height(queryW);
        if (this._lockedSize)
            return [0, Math.max(minH, this._lockedSize.height)];
        return [minH, natH];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.get_first_child();
        if (!child || !child.visible)
            return;

        const availW = Math.max(0, box.x2 - box.x1);
        const availH = Math.max(0, box.y2 - box.y1);

        let childW;
        let childH;
        if (this._lockedSize) {
            const [minW] = child.get_preferred_width(-1);
            childW = Math.max(minW, this._lockedSize.width);
            const [minH] = child.get_preferred_height(childW);
            childH = Math.max(minH, this._lockedSize.height);
        } else {
            const [minW] = child.get_preferred_width(-1);
            childW = Math.max(minW, availW);
            childH = availH;
        }

        const dx = Math.round((availW - childW) / 2);
        const cBox = new Clutter.ActorBox({
            x1: dx,
            y1: 0,
            x2: dx + childW,
            y2: childH,
        });
        child.allocate(cBox);
    }
});
