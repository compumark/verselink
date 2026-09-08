using VerseLink.Companion;using Xunit;
namespace VerseLink.Companion.Tests;
public class ParserTests{
[Theory][InlineData("TUNGSTEN (ORE)","Tungsten")][InlineData("Tungsten (Raw)","Tungsten")][InlineData("BORASE ORE","Borase")]public void Normalize(string a,string e)=>Assert.Equal(e,MaterialCatalog.Normalize(a));
[Fact]public void NumericCorrection(){var x=NumericParser.Parse("43I");Assert.Equal(431,x.Value);Assert.Equal("OCR_NUMERIC_CORRECTION",x.Warning);}
[Fact]public void QualityValidation(){Assert.DoesNotContain("INVALID_QUALITY",MiningParser.Parse("TUNGSTEN\nQUALITY 1000\nQTY 1").Rows[0].Warnings);Assert.Contains("INVALID_QUALITY",MiningParser.Parse("TUNGSTEN\nQUALITY 1001\nQTY 1").Rows[0].Warnings);}
[Fact]public void CompleteBlock(){var r=MiningParser.Parse("TUNGSTEN (ORE)\nQUALITY 975\nQTY 431\n\nLINDINIUM (ORE)\nQUALITY 618\nQTY 957");Assert.Equal(2,r.Rows.Count);Assert.Equal(431,r.Rows[0].Quantity);Assert.Equal("Lindinium",r.Rows[1].NormalizedMaterialName);}}
