"use strict";
(self.webpackChunktits_html = self.webpackChunktits_html || []).push([
  [416],
  {
    4024: (e, t, o) => {
      o.r(t);
      var n = o(83091);
      ((window.flyToPoeA = function () {
        (showBust("POE_A"),
          showName("坡A星"),
          author("Adjatha"),
          output(
            "为了找点乐子，你设定航线前往坡A星。不久，这颗行星便出现在显示屏上。以一个文明世界而言，它并不算特别大，但等待降落的飞行器多得有些荒唐。每分钟都有数千艘飞船抵达，而且涌入的势头丝毫没有放缓。它们来自银河系各处，其中甚至有你从未见过的型号。你排进降落队列，环顾其他访客；当你看到几艘价值恐怕抵得上整颗行星的飞船时，羡慕得眼睛都发酸了。看来，那些关于明星们在节日期间跑来体验平民生活的传闻并没有夸大！",
          ),
          processTime(5));
      }),
        (window.flyToPoeAConfirm = function () {
          (clearOutput(), clearMenu());
          var e = isHalloweenish(),
            t =
              void 0 === flags.POE_A_DISABLED ||
              (void 0 !== flags.POE_A_YEAR &&
                flags.POE_A_YEAR !== getRealtimeYear()),
            o = n.sg.isEntryUnlocked("erebus");
          if (t && !o)
            (showBust(""),
              showName(""),
              output(blockHeader("确认前往坡A星？")),
              output(
                "想起邀请函里的内容，这里举行的派对似乎很容易彻底失控，<b>并造成永久性的后果。</b>",
              ),
              output(
                "\n\n只有在你完全确定自己想来这里时，才应该继续。",
              ),
              void 0 !== flags.POE_A_DISABLED &&
                output(
                  "\n\n(坡A星被设计为一次性活动。<b>再次造访此地不属于正史，系统会将其视为你第一次来到这里。</b>请记住这一点，祝你万圣节快乐！)",
                ),
              addButton(
                0,
                "继续",
                function () {
                  return flyTo("Poe A");
                },
                "飞往坡A星",
                "我能承担后果！",
              ),
              addButton(14, "返回", window.flyMenu));
          else if (t && o)
            (showBust("POE_A"),
              showName("坡A星"),
              output(
                "想起邀请函里的内容，这里举行的派对似乎很容易彻底失控，<b>并造成永久性的后果。</b>不过，你还有别的选择：你又收到了一封邮件，邀请你在前往假面舞会之前先去某个名叫淫恐屋的地方。",
              ),
              void 0 !== flags.POE_A_DISABLED &&
                output(
                  "\n\n(假面舞会被设计为一次性活动。<b>再次参加该活动不属于正史，系统会将其视为你第一次参加。</b>请记住这一点，祝你万圣节快乐！)",
                ),
              addButton(
                0,
                "假面舞会",
                function () {
                  return flyTo("Poe A");
                },
                "前往假面舞会",
                "我能承担后果！",
              ),
              addButton(
                1,
                "淫恐屋",
                window.erebusGoGoGo,
                "闹鬼的淫恐屋",
                "阴森恐怖的性爱时光！",
              ),
              addButton(14, "返回", window.flyMenu));
          else {
            if (!o)
              return (
                showBust("POE_A"),
                showName("坡A星"),
                output(
                  blockHeader(e ? "去过了，也玩过了！" : "活动季已过！"),
                ),
                output(
                  "上次去过‘假面舞会’之后，你大概不该再返回坡A星了。",
                ),
                e
                  ? (output(
                      "\n\n况且，你已经参加过今年的庆典了 - 再回来也没有意义！",
                    ),
                    void addButton(0, "下一步", window.flyMenu))
                  : (output(
                      "\n\n(否则，你或许该等到活动季开始后，再决定是否回去。)",
                    ),
                    void addButton(0, "下一步", window.flyMenu))
              );
            (showBust("POE_A"),
              showName("坡A星"),
              output(
                "你现在可能无法参加假面舞会，但可以顺道去那间鬼屋" +
                  (void 0 !== flags.EREBUS_YEARDONE ? "再去一次.." : "") +
                  "。",
              ),
              addDisabledButton(
                0,
                "假面舞会",
                "假面舞会",
                e
                  ? "你今年已经参加过了！"
                  : "假面舞会目前不在开放季。",
              ),
              addButton(
                1,
                "淫恐屋",
                window.erebusGoGoGo,
                "闹鬼的淫恐屋",
                "阴森恐怖的性爱时光！",
              ),
              addButton(14, "返回", window.flyMenu));
          }
        }));
      var a = o(67856),
        i = o(87816),
        s = o(77231);
      (!(function () {
        var e = i.L.sector.findOrAddSystem("POE", "Poe"),
          t = new a.Nx();
        ((t.locationIndex = "POEA"),
          (t.locationName = "Poe A"),
          e.addLocation(t));
        var o = new a.du();
        ((o.index = "POESPACE"),
          (o.name = "Space"),
          (o.runOnEnter = window.puntToShip),
          o.addFlags(s.tb.OUTDOOR, s.tb.LOW_GRAVITY),
          t.addRoom(o));
      })(),
        (window.POEA = !0));
    },
  },
]);
//# sourceMappingURL=content_poea.67465771.js.map
